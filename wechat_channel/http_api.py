from __future__ import annotations

import json
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

from .service import WeChatChannelService


class ManagementServer:
    def __init__(self, host: str, port: int, service: WeChatChannelService, token: str = ""):
        self.host = host
        self.port = int(port)
        self.service = service
        self.token = token
        self.httpd = ThreadingHTTPServer((host, self.port), self._handler())
        self._thread: Optional[threading.Thread] = None

    def _handler(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "DSHWeChatChannel/0.1"

            def log_message(self, fmt: str, *args: Any) -> None:
                return

            def _origin_headers(self) -> Dict[str, str]:
                origin = self.headers.get("Origin", "")
                allowed = origin.startswith("http://127.0.0.1:") or origin.startswith("http://localhost:")
                return {"Access-Control-Allow-Origin": origin, "Vary": "Origin"} if allowed else {}

            def _authorized(self) -> bool:
                if not owner.token:
                    return True
                return self.headers.get("Authorization") == "Bearer " + owner.token or self.headers.get("X-WeChat-Channel-Token") == owner.token

            def _json(self, code: int, body: Dict[str, Any]) -> None:
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                for name, value in self._origin_headers().items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

            def _body(self) -> Dict[str, Any]:
                length = int(self.headers.get("Content-Length") or 0)
                if length > 1024 * 1024:
                    raise ValueError("request body is too large")
                raw = self.rfile.read(length) if length else b"{}"
                value = json.loads(raw.decode("utf-8"))
                if not isinstance(value, dict):
                    raise ValueError("request body must be an object")
                return value

            def do_OPTIONS(self) -> None:
                self.send_response(204)
                for name, value in self._origin_headers().items():
                    self.send_header(name, value)
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-WeChat-Channel-Token")
                self.end_headers()

            def do_GET(self) -> None:
                if not self._authorized():
                    return self._json(401, {"ok": False, "error": "unauthorized"})
                parsed = urlparse(self.path)
                query = parse_qs(parsed.query)
                limit = int((query.get("limit") or [100])[0])
                try:
                    if parsed.path == "/api/status":
                        return self._json(200, owner.service.status())
                    if parsed.path == "/api/history":
                        return self._json(200, {"ok": True, "items": owner.service.store.history(limit)})
                    if parsed.path == "/api/recent":
                        return self._json(200, {"ok": True, "items": owner.service.store.recent_messages(limit)})
                    if parsed.path == "/api/contacts":
                        return self._json(200, {"ok": True, "items": owner.service.receive.contacts(limit)})
                    if parsed.path == "/api/logs":
                        return self._json(200, {"ok": True, "items": owner.service.store.logs(limit)})
                    if parsed.path == "/api/events":
                        return self._events()
                    return self._json(404, {"ok": False, "error": "not found"})
                except Exception as exc:
                    return self._json(500, {"ok": False, "error": str(exc), "error_type": type(exc).__name__})

            def _events(self) -> None:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                for name, value in self._origin_headers().items():
                    self.send_header(name, value)
                self.end_headers()
                subscriber = owner.service.events.subscribe()
                try:
                    self.wfile.write(b": connected\n\n")
                    self.wfile.flush()
                    while True:
                        try:
                            event = subscriber.get(timeout=15)
                            payload = json.dumps(event["data"], ensure_ascii=False)
                            frame = "id: %s\nevent: %s\ndata: %s\n\n" % (event["id"], event["event"], payload)
                        except queue.Empty:
                            frame = ": keepalive\n\n"
                        self.wfile.write(frame.encode("utf-8"))
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                    pass
                finally:
                    owner.service.events.unsubscribe(subscriber)

            def do_POST(self) -> None:
                if not self._authorized():
                    return self._json(401, {"ok": False, "error": "unauthorized"})
                parsed = urlparse(self.path)
                try:
                    body = self._body()
                    if parsed.path == "/api/send":
                        key = owner.service.enqueue_send(str(body.get("target_id") or ""), str(body.get("text") or ""),
                                                         str(body.get("source_message_id") or "manual"))
                        return self._json(202, {"ok": True, "idempotency_key": key})
                    if parsed.path == "/api/echo":
                        enabled = owner.service.set_echo(bool(body.get("enabled", True)))
                        key = None
                        if body.get("target_id") and body.get("text"):
                            key = owner.service.enqueue_send(str(body["target_id"]), "[ECHO] " + str(body["text"]), "echo")
                        return self._json(200, {"ok": True, "enabled": enabled, "idempotency_key": key})
                    if parsed.path == "/api/recover":
                        return self._json(200, {"ok": True, "receive": owner.service.recover()})
                    return self._json(404, {"ok": False, "error": "not found"})
                except ValueError as exc:
                    return self._json(400, {"ok": False, "error": str(exc)})
                except Exception as exc:
                    return self._json(500, {"ok": False, "error": str(exc), "error_type": type(exc).__name__})

        return Handler

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self.httpd.serve_forever, name="wechat-management", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        if self._thread:
            self._thread.join(timeout=5)
