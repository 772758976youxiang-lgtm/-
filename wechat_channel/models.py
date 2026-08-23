from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class DriverHealth:
    ok: bool
    driver: str
    message: str = ""
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RawMessage:
    account_id: str
    conversation_id: str
    local_id: str
    sender_id: Any
    message_type: str
    content: str
    timestamp: int
    sort_seq: int
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class StandardMessage:
    message_id: str
    channel: str
    account_id: str
    conversation_id: str
    conversation_type: str
    sender_id: str
    message_type: str
    content: str
    timestamp: int
    raw: Dict[str, Any] = field(default_factory=dict)

    @property
    def conversation_key(self) -> str:
        return "wechat:%s:%s" % (self.account_id, self.conversation_id)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class MessageBatch:
    messages: List[RawMessage]
    cursors: Dict[str, int]
    baseline_conversations: List[str] = field(default_factory=list)
    initialization_key: Optional[str] = None


@dataclass(frozen=True)
class SendTask:
    target_id: str
    text: str
    source_message_id: str
    idempotency_key: str
    retry_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SendResult:
    ok: bool
    driver: str
    target_id: str
    idempotency_key: str
    error: Optional[str] = None
    attempts: int = 1
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class AgentReply:
    text: str
    session_id: str
    status: str = "completed"
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
