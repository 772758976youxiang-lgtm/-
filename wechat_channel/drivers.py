from __future__ import annotations

import json
import re
import threading
import time
from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .models import DriverHealth, MessageBatch, RawMessage, SendResult, SendTask
from .storage import StateStore


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return "<bytes:%d>" % len(value)
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return str(value)


class ReceiveDriver(ABC):
    @abstractmethod
    def health(self) -> DriverHealth:
        raise NotImplementedError

    @abstractmethod
    def poll(self) -> MessageBatch:
        raise NotImplementedError

    def recover(self) -> DriverHealth:
        return self.health()

    def contacts(self, limit: int = 100) -> List[Dict[str, Any]]:
        return []


class SendDriver(ABC):
    name = "send"

    @abstractmethod
    def health(self) -> DriverHealth:
        raise NotImplementedError

    @abstractmethod
    def send(self, task: SendTask) -> SendResult:
        raise NotImplementedError


def _json_request(url: str, payload: Optional[Dict[str, Any]], timeout: float, method: str = "POST") -> Any:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8", "replace")
        return json.loads(raw) if raw else {}


class WeChatDbReceiveDriver(ReceiveDriver):
    name = "wechatauto_db"

    def __init__(self, store: StateStore, account_id: str = "auto", recent_limit: int = 15,
                 message_limit: int = 3, db_factory: Optional[Callable[..., Any]] = None):
        self.store = store
        self.account_id_config = account_id
        self.recent_limit = int(recent_limit)
        self.message_limit = int(message_limit)
        self._db_factory = db_factory
        self._db = None
        self._lock = threading.RLock()

    def _database(self) -> Any:
        with self._lock:
            if self._db is None:
                factory = self._db_factory
                if factory is None:
                    from wechatauto import WeChatDB
                    factory = WeChatDB
                kwargs = {} if self.account_id_config in ("", "auto") else {"account": self.account_id_config}
                self._db = factory(**kwargs)
            return self._db

    def account_id(self) -> str:
        db = self._database()
        value = getattr(db, "wxid", None) or getattr(db, "account", None)
        if value:
            return str(value)
        info = db.get_self_info() or {}
        return str(info.get("username") or self.account_id_config or "unknown")

    def health(self) -> DriverHealth:
        try:
            db = self._database()
            info = db.get_self_info() or {}
            return DriverHealth(True, self.name, "database readable", {
                "account_id": str(info.get("username") or self.account_id()),
                "nickname": str(info.get("nick_name") or info.get("remark") or ""),
            })
        except Exception as exc:
            return DriverHealth(False, self.name, str(exc), {"error_type": type(exc).__name__})

    def poll(self) -> MessageBatch:
        db = self._database()
        account_id = self.account_id()
        initialization_key = "receive_baseline:" + account_id
        initialized = self.store.get_metadata(initialization_key) == "complete"
        sessions = db.get_sessions(limit=self.recent_limit) or []
        messages: List[RawMessage] = []
        cursors: Dict[str, int] = {}
        baseline: List[str] = []
        for session in sessions:
            conversation_id = str(session.get("username") or "")
            if not conversation_id:
                continue
            cursor = self.store.get_cursor(conversation_id)
            if cursor is None:
                latest = db.get_messages(conversation_id, limit=self.message_limit) or []
                high = max((int(item.get("sort_seq") or 0) for item in latest), default=0)
                unread = max(0, int(session.get("unread") or 0))
                if not initialized or unread == 0:
                    cursors[conversation_id] = high
                    baseline.append(conversation_id)
                    continue
                rows = sorted(latest, key=lambda item: int(item.get("sort_seq") or 0))[-min(unread, self.message_limit):]
                cursor = 0
            else:
                rows = db.get_new_messages(conversation_id, since_seq=cursor, limit=self.message_limit) or []
            high = cursor
            for row in rows:
                sort_seq = int(row.get("sort_seq") or 0)
                high = max(high, sort_seq)
                local_id = str(row.get("local_id") or row.get("server_id") or sort_seq)
                messages.append(RawMessage(
                    account_id=account_id,
                    conversation_id=conversation_id,
                    local_id=local_id,
                    sender_id=row.get("sender_id"),
                    message_type=str(row.get("type") or row.get("local_type") or "unknown"),
                    content=str(row.get("content") or ""),
                    timestamp=int(row.get("create_time") or 0),
                    sort_seq=sort_seq,
                    raw=_json_safe(dict(row)),
                ))
            cursors[conversation_id] = high
        messages.sort(key=lambda item: (item.sort_seq, item.timestamp, item.local_id))
        return MessageBatch(messages, cursors, baseline, None if initialized else initialization_key)

    def recover(self) -> DriverHealth:
        with self._lock:
            self._db = None
        return self.health()

    def display_name(self, target_id: str) -> str:
        if target_id == "filehelper":
            return "文件传输助手"
        try:
            return str(self._database().get_nickname(target_id) or target_id)
        except Exception:
            return target_id

    def contacts(self, limit: int = 100) -> List[Dict[str, Any]]:
        db = self._database()
        result = []
        for session in (db.get_sessions(limit=max(1, min(int(limit), 500))) or []):
            username = str(session.get("username") or "")
            if not username:
                continue
            try:
                name = str(db.get_nickname(username) or username)
            except Exception:
                name = username
            result.append({"id": username, "name": name, "type": "group" if "@chatroom" in username else "direct"})
        return result


class HookSendDriver(SendDriver):
    name = "aixed_hook"

    def __init__(self, endpoint: str, timeout: float = 15):
        self.endpoint = endpoint.rstrip("/")
        self.timeout = float(timeout)

    def health(self) -> DriverHealth:
        try:
            status = _json_request(self.endpoint + "/QueryDB/status", None, self.timeout, method="GET")
            return DriverHealth(True, self.name, "hook HTTP service reachable", {"status": status})
        except Exception as exc:
            return DriverHealth(False, self.name, str(exc), {"error_type": type(exc).__name__})

    def send(self, task: SendTask) -> SendResult:
        target = "filehelper" if task.target_id in ("self", "filehelper") else task.target_id
        try:
            response = _json_request(
                self.endpoint + "/SendTextMsg",
                {"wxidorgid": target, "msg": task.text},
                self.timeout,
            )
            ok = response.get("ret") in (0, "0")
            return SendResult(ok, self.name, target, task.idempotency_key,
                              None if ok else str(response.get("retmsg") or response), details={"response": response})
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
            return SendResult(False, self.name, target, task.idempotency_key, str(exc), details={"error_type": type(exc).__name__})


class UiaOcrSendDriver(SendDriver):
    name = "wechatauto_uia_ocr"

    def __init__(self, target_resolver: Optional[Callable[[str], str]] = None,
                 gui_factory: Optional[Callable[[], Any]] = None, verify: bool = True):
        self.target_resolver = target_resolver or (lambda value: value)
        self.gui_factory = gui_factory
        self.verify = verify
        self._gui = None
        self._lock = threading.RLock()

    def _client(self) -> Any:
        if self._gui is None:
            factory = self.gui_factory
            if factory is None:
                from wechatauto.guia import WeChatGUI
                factory = WeChatGUI
            self._gui = factory()
        return self._gui

    def health(self) -> DriverHealth:
        try:
            available = bool(self._client().desktop_available())
            return DriverHealth(available, self.name,
                                "desktop available" if available else "WeChat desktop is unavailable")
        except Exception as exc:
            return DriverHealth(False, self.name, str(exc), {"error_type": type(exc).__name__})

    def send(self, task: SendTask) -> SendResult:
        target = "文件传输助手" if task.target_id in ("self", "filehelper") else self.target_resolver(task.target_id)
        with self._lock:
            try:
                response = self._client().send_msg(task.text, who=target, verify=self.verify)
                if isinstance(response, dict):
                    ok = response.get("status") in ("成功", "success", "ok")
                    message = response.get("message")
                    details = {"status": response.get("status"), "message": message}
                else:
                    ok = bool(getattr(response, "ok", False) or getattr(response, "is_success", False))
                    message = str(response)
                    details = {"response": message[:500]}
                return SendResult(ok, self.name, target, task.idempotency_key, None if ok else str(message), details=details)
            except Exception as exc:
                self._gui = None
                return SendResult(False, self.name, target, task.idempotency_key, str(exc),
                                  details={"error_type": type(exc).__name__})


class SendRouter:
    def __init__(self, drivers: Sequence[SendDriver], max_retries: int = 2, retry_delay: float = 0.5):
        if not drivers:
            raise ValueError("at least one send driver is required")
        self.drivers = list(drivers)
        self.max_retries = max(0, int(max_retries))
        self.retry_delay = float(retry_delay)

    def health(self) -> List[Dict[str, Any]]:
        return [driver.health().to_dict() for driver in self.drivers]

    def send(self, task: SendTask) -> SendResult:
        attempts = 0
        errors = []
        for round_number in range(self.max_retries + 1):
            for driver in self.drivers:
                attempts += 1
                result = driver.send(task)
                if result.ok:
                    return SendResult(True, result.driver, result.target_id, result.idempotency_key,
                                      attempts=attempts, details=result.details)
                errors.append({"driver": driver.name, "error": result.error})
            if round_number < self.max_retries:
                time.sleep(self.retry_delay * (round_number + 1))
        return SendResult(False, self.drivers[-1].name, task.target_id, task.idempotency_key,
                          "; ".join(str(item["error"]) for item in errors if item["error"]) or "all send drivers failed",
                          attempts=attempts, details={"errors": errors})


_GROUP_PREFIX = re.compile(r"^([^:\n]+):\n([\s\S]*)$")


def parse_group_content(content: str, fallback_sender: Any) -> Tuple[str, str]:
    match = _GROUP_PREFIX.match(content or "")
    if match:
        return match.group(1).strip(), match.group(2)
    return str(fallback_sender), content
