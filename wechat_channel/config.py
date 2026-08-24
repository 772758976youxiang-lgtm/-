from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse


DEFAULT_CONFIG: Dict[str, Any] = {
    "service": {"host": "127.0.0.1", "port": 5176, "token_env": "WECHAT_CHANNEL_TOKEN"},
    "channel": {
        "type": "wechat_pc",
        "account_id": "auto",
        "poll_interval_ms": 1500,
        "recent_conversation_limit": 15,
        "message_limit_per_conversation": 3,
    },
    "receive": {
        "driver": "wechatauto_db",
        "package": "wechatauto-replica",
        "version": "1.1.7",
        "repository": "https://github.com/fanyuantaier/wechatauto-replica",
    },
    "send": {
        "primary": "aixed_hook",
        "hook_endpoint": "http://127.0.0.1:30001",
        "hook_wechat_version": "4.1.10.27",
        "hook_repository": "https://github.com/aixed/WeChat-Hook",
        "group_reply_mention_sender": True,
        "fallbacks": ["wechatauto_uia", "wechatauto_ocr"],
        "fallback_repository": "https://github.com/fanyuantaier/wechatauto-replica",
        "timeout_seconds": 90,
        "max_retries": 2,
    },
    "agent": {
        "adapter": "dsh",
        "endpoint": "http://127.0.0.1:3080",
        "token_env": "AGENT_TOKEN",
        "session_scope": "conversation",
        "workspace_dir": "",
        "preset": "channel-wechat-personal",
        "reply_timeout_seconds": 90,
    },
    "policy": {
        "direct_message": "allow",
        "group_message": "allow",
        "group_whitelist": [],
        "group_blacklist": [],
        "direct_whitelist": [],
        "direct_blacklist": [],
        "group_reply_only_when_mentioned_groups": [],
        "profile_write_authorized_contact": "",
        "sensitive_words": [],
        "rate_limit_per_minute": 10,
        "enabled": True,
    },
    "state": {
        "database": str(Path.home() / ".dsh-wechat-channel.sqlite3"),
        "recent_context_limit": 200,
        "media_dir": str(Path.home() / ".dsh-wechat-media"),
    },
    "runtime": {"echo": False},
}


def _merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = value
    return result


def _require_loopback_url(name: str, value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("%s must use a loopback HTTP endpoint" % name)


def load_config(path: Optional[str] = None) -> Dict[str, Any]:
    config = copy.deepcopy(DEFAULT_CONFIG)
    if path:
        source = Path(path).expanduser()
        if source.exists():
            with source.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
            if not isinstance(data, dict):
                raise ValueError("configuration root must be an object")
            config = _merge(config, data)

    if config["service"]["host"] not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("service.host must be loopback")
    if str(config["send"].get("hook_endpoint") or "").strip():
        _require_loopback_url("send.hook_endpoint", str(config["send"]["hook_endpoint"]))
    if config["agent"]["adapter"] == "dsh":
        _require_loopback_url("agent.endpoint", str(config["agent"]["endpoint"]))
    if int(config["send"]["max_retries"]) < 0:
        raise ValueError("send.max_retries must be non-negative")
    if int(config["channel"]["poll_interval_ms"]) < 250:
        raise ValueError("channel.poll_interval_ms must be at least 250")
    return config


def config_token(config: Dict[str, Any]) -> str:
    name = str(config["service"].get("token_env") or "")
    return os.environ.get(name, "") if name else ""
