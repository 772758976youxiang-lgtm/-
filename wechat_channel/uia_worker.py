from __future__ import annotations

import json
import sys
import threading
from typing import Any, Dict


def normalized_response(response: Any) -> Dict[str, Any]:
    if isinstance(response, dict):
        ok = response.get("status") in ("成功", "success", "ok")
        message = response.get("message")
        return {"ok": ok, "error": None if ok else str(message),
                "details": {"status": response.get("status"), "message": message}}
    ok = bool(getattr(response, "ok", False) or getattr(response, "is_success", False))
    message = str(response)
    return {"ok": ok, "error": None if ok else message, "details": {"response": message[:500]}}


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        import wechatauto.guia as guia

        guia.threading = threading
        client = guia.WeChatGUI(hwnd=int(payload.get("hwnd") or 0) or None)
        mention = str(payload.get("mention_name") or "").strip()
        if mention:
            response = client.at_member(mention, str(payload.get("text") or ""),
                                        who=str(payload.get("target") or ""),
                                        verify=bool(payload.get("verify", True)))
        else:
            response = client.send_msg(str(payload.get("text") or ""),
                                       who=str(payload.get("target") or ""),
                                       verify=bool(payload.get("verify", True)))
        result = normalized_response(response)
    except Exception as exc:
        result = {"ok": False, "error": str(exc), "details": {"error_type": type(exc).__name__}}
    print("DSH_UIA_RESULT=" + json.dumps(result, ensure_ascii=True), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
