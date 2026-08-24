from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, Optional, Sequence
from urllib.request import Request, urlopen

from .models import AgentReply, StandardMessage
from .storage import StateStore


class AgentAdapter(ABC):
    @abstractmethod
    def health(self) -> Dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def get_or_create_session(self, conversation_key: str, metadata: Dict[str, Any]) -> str:
        raise NotImplementedError

    @abstractmethod
    def respond(self, session_id: str, message: StandardMessage, metadata: Dict[str, Any]) -> AgentReply:
        raise NotImplementedError


class EchoAgentAdapter(AgentAdapter):
    def health(self) -> Dict[str, Any]:
        return {"ok": True, "adapter": "echo"}

    def get_or_create_session(self, conversation_key: str, metadata: Dict[str, Any]) -> str:
        return "echo:" + conversation_key

    def respond(self, session_id: str, message: StandardMessage, metadata: Dict[str, Any]) -> AgentReply:
        return AgentReply("[ECHO] " + message.content, session_id)


class HttpAgentAdapter(AgentAdapter):
    def __init__(self, endpoint: str, token: str = "", timeout: float = 90):
        self.endpoint = endpoint.rstrip("/")
        self.token = token
        self.timeout = float(timeout)

    def _request(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = Request(self.endpoint + path, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                          method="POST", headers=headers)
        with urlopen(request, timeout=self.timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
        if not isinstance(body, dict):
            raise RuntimeError("agent returned a non-object response")
        return body

    def health(self) -> Dict[str, Any]:
        try:
            request = Request(self.endpoint + "/health", method="GET")
            with urlopen(request, timeout=min(self.timeout, 5)) as response:
                return {"ok": 200 <= response.status < 300, "adapter": "http", "status": response.status}
        except Exception as exc:
            return {"ok": False, "adapter": "http", "error": str(exc)}

    def get_or_create_session(self, conversation_key: str, metadata: Dict[str, Any]) -> str:
        body = self._request("/sessions", {"conversation_key": conversation_key, "metadata": metadata})
        session_id = body.get("session_id")
        if not session_id:
            raise RuntimeError("agent session response is missing session_id")
        return str(session_id)

    def respond(self, session_id: str, message: StandardMessage, metadata: Dict[str, Any]) -> AgentReply:
        body = self._request("/respond", {"session_id": session_id, "message": message.to_dict(), "metadata": metadata})
        return AgentReply(str(body.get("text") or ""), str(body.get("session_id") or session_id),
                          str(body.get("status") or "completed"), body.get("error"))


class ProcessAgentAdapter(AgentAdapter):
    def __init__(self, command: Sequence[str], timeout: float = 90):
        if not command:
            raise ValueError("process adapter command is required")
        self.command = list(command)
        self.timeout = float(timeout)

    def health(self) -> Dict[str, Any]:
        return {"ok": True, "adapter": "process", "command": self.command[0]}

    def get_or_create_session(self, conversation_key: str, metadata: Dict[str, Any]) -> str:
        return conversation_key

    def respond(self, session_id: str, message: StandardMessage, metadata: Dict[str, Any]) -> AgentReply:
        payload = json.dumps({"session_id": session_id, "message": message.to_dict(), "metadata": metadata}, ensure_ascii=False)
        completed = subprocess.run(self.command, input=payload, text=True, capture_output=True,
                                   timeout=self.timeout, check=False)
        if completed.returncode != 0:
            return AgentReply("", session_id, "failed", completed.stderr.strip() or "process agent failed")
        try:
            body = json.loads(completed.stdout)
            return AgentReply(str(body.get("text") or ""), str(body.get("session_id") or session_id),
                              str(body.get("status") or "completed"), body.get("error"))
        except json.JSONDecodeError:
            return AgentReply(completed.stdout.strip(), session_id)


class DshAgentAdapter(AgentAdapter):
    def __init__(self, endpoint: str, store: StateStore, workspace_dir: str = "", preset: str = "robot-assistant",
                 timeout: float = 90):
        self.endpoint = endpoint.rstrip("/")
        self.store = store
        self.workspace_dir = str(Path(workspace_dir).expanduser()) if workspace_dir else str(Path.home() / "DeepSeek" / "im-workspaces" / "wechat")
        self.preset = preset
        self.timeout = float(timeout)
        self._rpc_seq = 0
        self._workspace_id: Optional[str] = None
        self._lock = threading.RLock()
        self._session_locks: Dict[str, threading.Lock] = {}

    def _rpc(self, method: str, payload: Dict[str, Any]) -> Any:
        with self._lock:
            self._rpc_seq += 1
            rpc_id = "wechat-%s-%d" % (uuid.uuid4().hex[:8], self._rpc_seq)
        request = Request(
            self.endpoint + "/api/" + method,
            data=json.dumps({"type": "client-request", "rpcId": rpc_id, "method": method, "payload": payload}, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request, timeout=min(self.timeout, 30)) as response:
            body = json.loads(response.read().decode("utf-8"))
        result = body.get("result") if isinstance(body, dict) else None
        if not isinstance(result, dict) or not result.get("ok"):
            error = result.get("error") if isinstance(result, dict) else body
            raise RuntimeError("DSH %s failed: %s" % (method, error))
        return result.get("value")

    def health(self) -> Dict[str, Any]:
        try:
            value = self._rpc("workspace.list", {})
            return {"ok": True, "adapter": "dsh", "workspace_count": len(value.get("items") or [])}
        except Exception as exc:
            return {"ok": False, "adapter": "dsh", "error": str(exc)}

    def _workspace(self) -> str:
        if self._workspace_id:
            return self._workspace_id
        Path(self.workspace_dir).mkdir(parents=True, exist_ok=True)
        value = self._rpc("workspace.list", {})
        found = next((item for item in (value.get("items") or []) if item.get("path") == self.workspace_dir), None)
        if found:
            self._workspace_id = str(found["workspaceId"])
        else:
            created = self._rpc("workspace.create", {"path": self.workspace_dir})
            self._workspace_id = str(created["workspace"]["workspaceId"])
        try:
            self._rpc("workspace.rename", {"workspaceId": self._workspace_id, "title": "微信通道"})
        except Exception:
            pass
        return self._workspace_id

    def get_or_create_session(self, conversation_key: str, metadata: Dict[str, Any]) -> str:
        existing = self.store.get_session(conversation_key)
        title = "微信·" + str(metadata.get("conversation_name") or metadata.get("conversation_id") or "会话")
        if existing:
            # Contact/group remarks can become available after a session was first
            # created. Keep the existing Harness session aligned on every message.
            try:
                self._rpc("session.rename", {"sessionId": existing, "title": title[:40]})
            except Exception:
                pass
            return existing
        created = self._rpc("session.create", {"workspaceId": self._workspace(), "agentPreset": self.preset})
        session_id = str(created["sessionId"])
        self.store.set_session(conversation_key, session_id, metadata)
        try:
            self._rpc("session.rename", {"sessionId": session_id, "title": title[:40]})
        except Exception:
            pass
        return session_id

    @staticmethod
    def _message_text(message: Dict[str, Any]) -> str:
        return "".join(str(block.get("text") or "") for block in (message.get("content") or []) if block.get("type") == "text")

    def _history_max_seq(self, session_id: str) -> int:
        history = self._rpc("session.history", {"sessionId": session_id, "maxMessages": 10})
        return max((int(item.get("event", {}).get("seq") or 0) for item in (history.get("events") or [])), default=0)

    @staticmethod
    def _contextual_prompt(message: StandardMessage, metadata: Dict[str, Any]) -> str:
        kind = "群聊" if message.conversation_type == "group" else "私聊"
        lines = [
            "【微信消息上下文】",
            "会话类型：" + kind,
            "会话名称：" + str(metadata.get("conversation_name") or message.conversation_id),
            "会话 ID：" + message.conversation_id,
            "发送者：" + str(metadata.get("sender_name") or message.sender_id),
            "发送者 ID：" + message.sender_id,
        ]
        for label, key in (("会话备注", "conversation_remark"), ("会话微信号", "conversation_wechat_id"),
                           ("发送者备注", "sender_remark"), ("发送者微信号", "sender_wechat_id")):
            if metadata.get(key):
                lines.append(label + "：" + str(metadata[key]))
        if metadata.get("quoted_message"):
            lines.append("引用消息发送者：" + str(metadata.get("quoted_sender") or "未知"))
            lines.append("引用的消息：" + str(metadata["quoted_message"]))
        return "\n".join(lines) + "\n【用户消息】\n" + message.content

    def respond(self, session_id: str, message: StandardMessage, metadata: Dict[str, Any]) -> AgentReply:
        with self._lock:
            session_lock = self._session_locks.setdefault(session_id, threading.Lock())
        with session_lock:
            baseline = self._history_max_seq(session_id)
            self._rpc("session.prompt", {"sessionId": session_id, "mode": "queue", "content": [{"type": "text", "text": self._contextual_prompt(message, metadata)}]})
            deadline = time.time() + self.timeout
            best = ""
            last_seq = baseline
            while time.time() < deadline:
                history = self._rpc("session.history", {"sessionId": session_id, "maxMessages": 30})
                ended = False
                for item in history.get("events") or []:
                    event = item.get("event") or {}
                    seq = int(event.get("seq") or 0)
                    if seq <= baseline:
                        continue
                    last_seq = max(last_seq, seq)
                    if event.get("type") == "assistant/message":
                        text = self._message_text((event.get("data") or {}).get("message") or {})
                        if text:
                            best = text
                    if event.get("type") == "turn/end":
                        ended = True
                if ended and best:
                    return AgentReply(best, session_id)
                time.sleep(1.5)
            return AgentReply(best, session_id, "timeout", None if best else "DSH reply timeout")


def make_agent_adapter(config: Dict[str, Any], store: StateStore) -> AgentAdapter:
    settings = config["agent"]
    kind = str(settings.get("adapter") or "dsh")
    timeout = float(settings.get("reply_timeout_seconds") or 90)
    if kind == "echo":
        return EchoAgentAdapter()
    if kind == "http":
        token_name = str(settings.get("token_env") or "")
        return HttpAgentAdapter(str(settings["endpoint"]), os.environ.get(token_name, "") if token_name else "", timeout)
    if kind == "process":
        return ProcessAgentAdapter(settings.get("command") or [], timeout)
    if kind == "dsh":
        return DshAgentAdapter(str(settings["endpoint"]), store, str(settings.get("workspace_dir") or ""),
                               str(settings.get("preset") or "robot-assistant"), timeout)
    raise ValueError("unsupported agent adapter: " + kind)
