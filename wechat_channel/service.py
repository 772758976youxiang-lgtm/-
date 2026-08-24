from __future__ import annotations

import collections
import re
import queue
import threading
import time
import uuid
from typing import Any, Deque, Dict, List, Optional

from .agents import AgentAdapter, EchoAgentAdapter
from .drivers import ReceiveDriver, SendRouter, parse_group_content
from .models import RawMessage, SendTask, StandardMessage
from .storage import StateStore


class MessageProcessingError(RuntimeError):
    pass


class EventBus:
    def __init__(self, history_limit: int = 200):
        self._history: Deque[Dict[str, Any]] = collections.deque(maxlen=history_limit)
        self._subscribers: List[queue.Queue] = []
        self._lock = threading.RLock()

    def publish(self, event_type: str, data: Dict[str, Any]) -> Dict[str, Any]:
        event = {"id": uuid.uuid4().hex, "event": event_type, "data": data, "timestamp": int(time.time() * 1000)}
        with self._lock:
            self._history.append(event)
            for subscriber in list(self._subscribers):
                try:
                    subscriber.put_nowait(event)
                except queue.Full:
                    pass
        return event

    def subscribe(self) -> queue.Queue:
        subscriber: queue.Queue = queue.Queue(maxsize=200)
        with self._lock:
            self._subscribers.append(subscriber)
        return subscriber

    def unsubscribe(self, subscriber: queue.Queue) -> None:
        with self._lock:
            if subscriber in self._subscribers:
                self._subscribers.remove(subscriber)


class Policy:
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self._timestamps: Dict[str, Deque[float]] = {}
        self._lock = threading.RLock()

    def allow(self, message: StandardMessage) -> tuple:
        if not bool(self.config.get("enabled", True)):
            return False, "emergency stop is enabled"
        if any(str(word) and str(word) in message.content for word in (self.config.get("sensitive_words") or [])):
            return False, "sensitive-word policy denied the message"
        if message.conversation_type == "direct":
            mode = self.config.get("direct_message", "allow")
            whitelist = set(str(value) for value in (self.config.get("direct_whitelist") or []))
            blacklist = set(str(value) for value in (self.config.get("direct_blacklist") or []))
        else:
            mode = self.config.get("group_message", "whitelist")
            whitelist = set(str(value) for value in (self.config.get("group_whitelist") or []))
            blacklist = set(str(value) for value in (self.config.get("group_blacklist") or []))
        if message.conversation_id in blacklist:
            return False, "conversation is blacklisted"
        if mode == "deny":
            return False, "conversation type denied"
        if mode == "whitelist" and message.conversation_id not in whitelist:
            return False, "conversation is not whitelisted"
        limit = max(1, int(self.config.get("rate_limit_per_minute") or 10))
        now = time.monotonic()
        with self._lock:
            timestamps = self._timestamps.setdefault(message.conversation_key, collections.deque())
            while timestamps and now - timestamps[0] >= 60:
                timestamps.popleft()
            if len(timestamps) >= limit:
                return False, "rate limit exceeded"
            timestamps.append(now)
        return True, "allowed"


def normalize_message(raw: RawMessage) -> StandardMessage:
    is_group = "@chatroom" in raw.conversation_id
    if is_group:
        sender_id, content = parse_group_content(raw.content, raw.sender_id)
    else:
        sender_id, content = raw.conversation_id, raw.content
    return StandardMessage(
        message_id="wechat:%s:%s:%s" % (raw.account_id, raw.conversation_id, raw.local_id),
        channel="wechat",
        account_id=raw.account_id,
        conversation_id=raw.conversation_id,
        conversation_type="group" if is_group else "direct",
        sender_id=str(sender_id),
        message_type=raw.message_type,
        content=content,
        timestamp=raw.timestamp,
        raw=raw.raw,
    )


class WeChatChannelService:
    def __init__(self, config: Dict[str, Any], store: StateStore, receive: ReceiveDriver,
                 send_router: SendRouter, agent: AgentAdapter):
        self.config = config
        self.store = store
        self.receive = receive
        self.send_router = send_router
        self.agent = agent
        self.policy = Policy(config["policy"])
        self.events = EventBus()
        self._send_queue: queue.Queue = queue.Queue()
        self._stop = threading.Event()
        self._poll_thread: Optional[threading.Thread] = None
        self._send_thread: Optional[threading.Thread] = None
        self._started_at = 0
        self._last_poll_at = 0
        self._last_error: Optional[str] = None
        self._echo = bool(config.get("runtime", {}).get("echo", False))

    def log(self, level: str, event: str, message: str, data: Optional[Dict[str, Any]] = None) -> None:
        item = self.store.add_log(level, event, message, data)
        self.events.publish("log", item)
        print("[%s] [%s] %s" % (level.upper(), event, message), flush=True)

    def start(self) -> None:
        if self._poll_thread and self._poll_thread.is_alive():
            return
        self._stop.clear()
        self._started_at = int(time.time() * 1000)
        for item in self.store.pending_send_tasks():
            self._send_queue.put(SendTask(item["target_id"], item["text"], item["source_message_id"],
                                          item["idempotency_key"], int(item.get("attempts") or 0)))
        self._send_thread = threading.Thread(target=self._send_loop, name="wechat-send", daemon=True)
        self._poll_thread = threading.Thread(target=self._poll_loop, name="wechat-receive", daemon=True)
        self._send_thread.start()
        self._poll_thread.start()
        self.log("info", "service", "WeChat channel started")

    def stop(self) -> None:
        self._stop.set()
        self._send_queue.put(None)
        if self._poll_thread:
            self._poll_thread.join(timeout=5)
        if self._send_thread:
            self._send_thread.join(timeout=5)
        self.log("info", "service", "WeChat channel stopped")

    def _poll_loop(self) -> None:
        interval = max(0.25, int(self.config["channel"]["poll_interval_ms"]) / 1000.0)
        consecutive_failures = 0
        while not self._stop.is_set():
            try:
                self.poll_once()
                consecutive_failures = 0
                self._last_error = None
            except MessageProcessingError as exc:
                consecutive_failures = 0
                self._last_error = str(exc)
                self.log("error", "message", str(exc), {"error_type": type(exc.__cause__).__name__ if exc.__cause__ else type(exc).__name__})
            except Exception as exc:
                consecutive_failures += 1
                self._last_error = str(exc)
                self.log("error", "receive", str(exc), {"error_type": type(exc).__name__, "consecutive_failures": consecutive_failures})
                if consecutive_failures >= 3:
                    health = self.receive.recover()
                    self.events.publish("status", {"receive_recovery": health.to_dict()})
                    consecutive_failures = 0
            self._stop.wait(interval)

    def poll_once(self) -> None:
        batch = self.receive.poll()
        for conversation_id in batch.baseline_conversations:
            self.store.set_cursor(conversation_id, batch.cursors.get(conversation_id, 0))
            self.log("info", "baseline", "conversation baseline established", {"conversation_id": conversation_id})
        if batch.initialization_key:
            self.store.set_metadata(batch.initialization_key, "complete")
        for raw in batch.messages:
            try:
                self._handle_raw(raw)
            except Exception as exc:
                raise MessageProcessingError("failed to process %s: %s" % (raw.local_id, exc)) from exc
        self._last_poll_at = int(time.time() * 1000)
        self.events.publish("recent", {"received": len(batch.messages), "baselined": len(batch.baseline_conversations)})

    def _handle_raw(self, raw: RawMessage) -> None:
        if raw.sender_id in (2, "2"):
            self.store.set_cursor(raw.conversation_id, raw.sort_seq)
            self.log("debug", "self_message", "ignored message sent by self", {"conversation_id": raw.conversation_id})
            return
        message = normalize_message(raw)
        if self.store.is_processed(message.message_id):
            self.store.set_cursor(raw.conversation_id, raw.sort_seq)
            return
        if message.message_type.lower() not in ("text", "1", "文本", "文字", "文字消息") or not message.content.strip():
            self._record_processed(message.message_id, message.conversation_id, message.to_dict())
            self.store.set_cursor(raw.conversation_id, raw.sort_seq)
            self.log("debug", "unsupported_message", "ignored non-text or empty message", {"message_id": message.message_id, "message_type": message.message_type})
            return
        conversation_profile = self.receive.contact_profile(message.conversation_id)
        sender_profile = self.receive.contact_profile(message.sender_id)
        metadata = {
            "channel": "wechat",
            "account_id": message.account_id,
            "conversation_id": message.conversation_id,
            "conversation_type": message.conversation_type,
            "sender_id": message.sender_id,
            "conversation_name": conversation_profile.get("display_name") or message.conversation_id,
            "conversation_nickname": conversation_profile.get("nickname") or "",
            "conversation_remark": conversation_profile.get("remark") or "",
            "conversation_wechat_id": conversation_profile.get("wechat_id") or "",
            "sender_name": sender_profile.get("display_name") or message.sender_id,
            "sender_nickname": sender_profile.get("nickname") or "",
            "sender_remark": sender_profile.get("remark") or "",
            "sender_wechat_id": sender_profile.get("wechat_id") or "",
        }
        quote = self._quote_context(message.content)
        if quote:
            metadata.update(quote)
        allowed, reason = self.policy.allow(message)
        mentioned = self.receive.mentions_self(raw.content) if message.conversation_type == "group" else False
        mention_groups = set(str(value) for value in (self.config["policy"].get("group_reply_only_when_mentioned_groups") or []))
        if allowed and message.conversation_type == "group" and message.conversation_id in mention_groups and not mentioned:
            allowed, reason = False, "group message does not mention account"
        record = message.to_dict()
        record["context"] = metadata
        record["reply_allowed"] = allowed
        record["policy_reason"] = reason
        record["mentioned"] = mentioned
        if not allowed:
            self._record_processed(message.message_id, message.conversation_id, record)
            self.store.set_cursor(raw.conversation_id, raw.sort_seq)
            self.events.publish("context", {"message": record})
            self.log("info", "context", "message recorded without reply", {"message_id": message.message_id, "conversation_id": message.conversation_id, "reason": reason})
            return
        adapter = EchoAgentAdapter() if self._echo else self.agent
        session_id = adapter.get_or_create_session(message.conversation_key, metadata)
        reply = adapter.respond(session_id, message, metadata)
        if reply.status not in ("completed", "success") or reply.error:
            raise RuntimeError(reply.error or "agent response failed: " + reply.status)
        if not reply.text.strip():
            raise RuntimeError("agent returned an empty reply")
        task = SendTask(message.conversation_id, reply.text, message.message_id, message.message_id + ":reply")
        if self.store.create_send_task(task.to_dict()):
            self._send_queue.put(task)
        self._record_processed(message.message_id, message.conversation_id, record)
        self.store.set_cursor(raw.conversation_id, raw.sort_seq)
        self.events.publish("message", {"message": record, "session_id": reply.session_id})
        self.log("info", "message", "message routed to agent", {"message_id": message.message_id, "session_id": reply.session_id})

    @staticmethod
    def _quote_context(content: str) -> Dict[str, str]:
        match = re.match(r"^(.*?)\n(?:引用|回复)\s*(.*?)\s*的消息\s*[:：]\s*(.+)$", str(content or ""), re.S)
        if not match:
            return {}
        return {"quoted_message": match.group(3).strip(), "quoted_sender": match.group(2).strip()}

    def _record_processed(self, message_id: str, conversation_id: str, payload: Dict[str, Any]) -> None:
        self.store.mark_processed(message_id, conversation_id, payload)
        self.store.prune_recent_messages(int(self.config["state"].get("recent_context_limit", 200)))

    def _send_loop(self) -> None:
        while not self._stop.is_set():
            task = self._send_queue.get()
            if task is None:
                return
            result = self.send_router.send(task)
            self.store.finish_send_task(task.idempotency_key, result.ok, result.driver, result.attempts, result.error)
            self.events.publish("send", result.to_dict())
            self.log("info" if result.ok else "error", "send",
                     "message sent" if result.ok else "message send failed", result.to_dict())

    def enqueue_send(self, target_id: str, text: str, source_message_id: str = "manual") -> str:
        if not target_id or not text.strip():
            raise ValueError("target_id and text are required")
        key = "%s:%s" % (source_message_id, uuid.uuid4().hex)
        task = SendTask(target_id, text, source_message_id, key)
        if not self.store.create_send_task(task.to_dict()):
            raise RuntimeError("duplicate send task")
        self._send_queue.put(task)
        return key

    def set_echo(self, enabled: bool) -> bool:
        self._echo = bool(enabled)
        self.events.publish("status", {"echo": self._echo})
        return self._echo

    def recover(self) -> Dict[str, Any]:
        health = self.receive.recover().to_dict()
        self.events.publish("status", {"recover": health})
        return health

    def status(self) -> Dict[str, Any]:
        return {
            "ok": self._last_error is None,
            "running": bool(self._poll_thread and self._poll_thread.is_alive()),
            "started_at": self._started_at,
            "last_poll_at": self._last_poll_at,
            "last_error": self._last_error,
            "echo": self._echo,
            "queue_size": self._send_queue.qsize(),
            "receive": self.receive.health().to_dict(),
            "send": self.send_router.health(),
            "agent": self.agent.health(),
        }
