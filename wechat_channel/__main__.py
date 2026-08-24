from __future__ import annotations

import argparse
import json
import signal
import sys
import threading
from typing import Any, Dict

from .agents import make_agent_adapter
from .config import config_token, load_config
from .drivers import HookSendDriver, SendRouter, UiaOcrSendDriver, WeChatDbReceiveDriver
from .http_api import ManagementServer
from .service import WeChatChannelService
from .storage import StateStore


def build_service(config: Dict[str, Any]) -> WeChatChannelService:
    store = StateStore(str(config["state"]["database"]))
    receive = WeChatDbReceiveDriver(
        store,
        str(config["channel"].get("account_id") or "auto"),
        int(config["channel"]["recent_conversation_limit"]),
        int(config["channel"]["message_limit_per_conversation"]),
    )
    send_settings = config["send"]
    drivers = []
    hook_endpoint = str(send_settings.get("hook_endpoint") or "").strip()
    if hook_endpoint:
        drivers.append(HookSendDriver(hook_endpoint, float(send_settings["timeout_seconds"])))
    if send_settings.get("fallbacks"):
        drivers.append(UiaOcrSendDriver(receive.display_name, verify=True, hwnd=config.get("runtime", {}).get("wechatHwnd")))
    router = SendRouter(drivers, int(send_settings["max_retries"]))
    agent = make_agent_adapter(config, store)
    return WeChatChannelService(config, store, receive, router, agent)


def diagnose(config: Dict[str, Any]) -> int:
    service = build_service(config)
    result = {
        "receive": service.receive.health().to_dict(),
        "send": service.send_router.health(),
        "agent": service.agent.health(),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["receive"]["ok"] and any(item["ok"] for item in result["send"]) else 1


def run(config: Dict[str, Any]) -> int:
    service = build_service(config)
    api = ManagementServer(str(config["service"]["host"]), int(config["service"]["port"]), service, config_token(config))
    stop = threading.Event()

    def handle_signal(_signum, _frame):
        stop.set()

    signal.signal(signal.SIGINT, handle_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, handle_signal)
    service.start()
    api.start()
    print("WeChat management API: http://%s:%s/api/status" % (config["service"]["host"], config["service"]["port"]), flush=True)
    try:
        while not stop.wait(0.5):
            pass
    finally:
        api.stop()
        service.stop()
        service.store.close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="DSH Windows WeChat channel")
    parser.add_argument("command", nargs="?", choices=("run", "diagnose"), default="run")
    parser.add_argument("--config", default=None, help="JSON configuration file")
    args = parser.parse_args()
    config = load_config(args.config)
    return diagnose(config) if args.command == "diagnose" else run(config)


if __name__ == "__main__":
    sys.exit(main())
