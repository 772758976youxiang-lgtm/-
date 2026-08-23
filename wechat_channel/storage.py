from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


class StateStore:
    def __init__(self, path: str):
        self.path = str(Path(path).expanduser())
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._migrate()

    def _migrate(self) -> None:
        with self._lock, self._db:
            self._db.executescript(
                """
                CREATE TABLE IF NOT EXISTS cursors (
                  conversation_id TEXT PRIMARY KEY,
                  sort_seq INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS metadata (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS processed_messages (
                  message_id TEXT PRIMARY KEY,
                  conversation_id TEXT NOT NULL,
                  processed_at INTEGER NOT NULL,
                  payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                  conversation_key TEXT PRIMARY KEY,
                  session_id TEXT NOT NULL,
                  metadata_json TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS send_tasks (
                  idempotency_key TEXT PRIMARY KEY,
                  source_message_id TEXT NOT NULL,
                  target_id TEXT NOT NULL,
                  text TEXT NOT NULL,
                  status TEXT NOT NULL,
                  driver TEXT,
                  attempts INTEGER NOT NULL DEFAULT 0,
                  error TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS logs (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  level TEXT NOT NULL,
                  event TEXT NOT NULL,
                  message TEXT NOT NULL,
                  data_json TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                );
                """
            )

    @staticmethod
    def _now() -> int:
        return int(time.time() * 1000)

    def get_cursor(self, conversation_id: str) -> Optional[int]:
        with self._lock:
            row = self._db.execute("SELECT sort_seq FROM cursors WHERE conversation_id=?", (conversation_id,)).fetchone()
        return int(row["sort_seq"]) if row else None

    def get_metadata(self, key: str) -> Optional[str]:
        with self._lock:
            row = self._db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return str(row["value"]) if row else None

    def set_metadata(self, key: str, value: str) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO metadata(key,value,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                (key, value, self._now()),
            )

    def set_cursor(self, conversation_id: str, sort_seq: int) -> None:
        now = self._now()
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO cursors(conversation_id,sort_seq,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(conversation_id) DO UPDATE SET sort_seq=excluded.sort_seq,updated_at=excluded.updated_at",
                (conversation_id, int(sort_seq), now),
            )

    def is_processed(self, message_id: str) -> bool:
        with self._lock:
            return self._db.execute("SELECT 1 FROM processed_messages WHERE message_id=?", (message_id,)).fetchone() is not None

    def mark_processed(self, message_id: str, conversation_id: str, payload: Dict[str, Any]) -> bool:
        with self._lock, self._db:
            cursor = self._db.execute(
                "INSERT OR IGNORE INTO processed_messages(message_id,conversation_id,processed_at,payload_json) VALUES(?,?,?,?)",
                (message_id, conversation_id, self._now(), json.dumps(payload, ensure_ascii=False, default=str)),
            )
        return cursor.rowcount == 1

    def get_session(self, conversation_key: str) -> Optional[str]:
        with self._lock:
            row = self._db.execute("SELECT session_id FROM sessions WHERE conversation_key=?", (conversation_key,)).fetchone()
        return str(row["session_id"]) if row else None

    def set_session(self, conversation_key: str, session_id: str, metadata: Dict[str, Any]) -> None:
        now = self._now()
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO sessions(conversation_key,session_id,metadata_json,updated_at) VALUES(?,?,?,?) "
                "ON CONFLICT(conversation_key) DO UPDATE SET session_id=excluded.session_id,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at",
                (conversation_key, session_id, json.dumps(metadata, ensure_ascii=False, default=str), now),
            )

    def create_send_task(self, task: Dict[str, Any]) -> bool:
        now = self._now()
        with self._lock, self._db:
            cursor = self._db.execute(
                "INSERT OR IGNORE INTO send_tasks(idempotency_key,source_message_id,target_id,text,status,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (task["idempotency_key"], task["source_message_id"], task["target_id"], task["text"], "queued", now, now),
            )
        return cursor.rowcount == 1

    def finish_send_task(self, key: str, ok: bool, driver: str, attempts: int, error: Optional[str]) -> None:
        with self._lock, self._db:
            self._db.execute(
                "UPDATE send_tasks SET status=?,driver=?,attempts=?,error=?,updated_at=? WHERE idempotency_key=?",
                ("sent" if ok else "failed", driver, attempts, error, self._now(), key),
            )

    def pending_send_tasks(self) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT idempotency_key,source_message_id,target_id,text,attempts FROM send_tasks WHERE status='queued' ORDER BY created_at ASC"
            ).fetchall()
        return [dict(row) for row in rows]

    def add_log(self, level: str, event: str, message: str, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        item = {"level": level, "event": event, "message": message, "data": data or {}, "created_at": self._now()}
        with self._lock, self._db:
            cursor = self._db.execute(
                "INSERT INTO logs(level,event,message,data_json,created_at) VALUES(?,?,?,?,?)",
                (level, event, message, json.dumps(item["data"], ensure_ascii=False, default=str), item["created_at"]),
            )
            item["id"] = cursor.lastrowid
        return item

    def logs(self, limit: int = 100) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit), 500))
        with self._lock:
            rows = self._db.execute("SELECT * FROM logs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [
            {"id": row["id"], "level": row["level"], "event": row["event"], "message": row["message"],
             "data": json.loads(row["data_json"]), "created_at": row["created_at"]}
            for row in reversed(rows)
        ]

    def history(self, limit: int = 100) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit), 500))
        with self._lock:
            rows = self._db.execute("SELECT * FROM send_tasks ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(row) for row in rows]

    def recent_messages(self, limit: int = 100) -> List[Dict[str, Any]]:
        limit = max(1, min(int(limit), 500))
        with self._lock:
            rows = self._db.execute(
                "SELECT message_id,conversation_id,processed_at,payload_json FROM processed_messages ORDER BY processed_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {"message_id": row["message_id"], "conversation_id": row["conversation_id"],
             "processed_at": row["processed_at"], "message": json.loads(row["payload_json"])}
            for row in rows
        ]

    def close(self) -> None:
        with self._lock:
            self._db.close()
