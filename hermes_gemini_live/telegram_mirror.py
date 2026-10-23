"""Restart-safe asynchronous Telegram task journal for Mini Live lanes."""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)

TERMINAL_EVENTS = frozenset({
    "completed", "failed", "cancelled", "interrupted", "timed_out", "unavailable",
})
EVENTS = frozenset({"started", "needs_input", *TERMINAL_EVENTS})
MAX_PREVIEW_CHARS = 180


def sanitize_preview(value: str) -> str:
    text = str(value or "").replace("```", " ")
    text = re.sub(r"(?:/Users/|~/)[^\s;,]+", "[private path]", text)
    text = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[private email]", text)
    text = re.sub(r"\b(?:gh[pousr]_|sk-|AIza)[A-Za-z0-9_-]{8,}\b", "[private token]", text)
    text = re.sub(r"https?://\S+", "[private link]", text)
    text = re.sub(r"\bAuthorization\s*:\s*Bearer\s+\S+", "[private authorization]", text, flags=re.I)
    text = re.sub(r"\b[A-Za-z]:\\\\Users\\\\[^\s;,]+", "[private path]", text, flags=re.I)
    text = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[private address]", text)
    text = re.sub(
        r"\b(?:token|secret|password|api[_ -]?key)\s*[:=]\s*\S+",
        "[private value]", text, flags=re.I,
    )
    return " ".join(text.split())[:MAX_PREVIEW_CHARS] or "No safe preview available."


def _message(event: str, preview: str) -> str:
    if event == "started":
        return f"🎙️ Mini Live task started\n{preview}\nStatus: working"
    if event == "needs_input":
        return f"⚠️ Mini Live task needs your input\n{preview}"
    labels = {
        "completed": "completed", "failed": "failed", "cancelled": "cancelled",
        "interrupted": "interrupted", "timed_out": "timed out", "unavailable": "unavailable",
    }
    return f"🎙️ Mini Live task {labels[event]}\n{preview}"


def _default_sender(payload: dict) -> bool:
    from tools.send_message_tool import send_message_tool
    raw = send_message_tool(payload)
    result = json.loads(raw) if isinstance(raw, str) else raw
    return bool(isinstance(result, dict) and result.get("success"))


class TelegramMirror:
    def __init__(self, path: Path, *, sender: Callable[[dict], bool] | None = None,
                 poll_seconds: float = 1.0, lease_seconds: float = 30.0) -> None:
        self.path = Path(path)
        self.sender = sender or _default_sender
        self.poll_seconds = poll_seconds
        self.lease_seconds = lease_seconds
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._closed = False
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gml-telegram-enqueue")
        self._init_db()

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def enqueue(self, lane, event: str, *, task_id: str, preview: str) -> bool:
        event = str(event).strip().lower()
        if event not in EVENTS:
            raise ValueError("unsupported mirrored task event")
        lane_id = str(getattr(lane, "id", "")).strip()
        chat_id = str(getattr(lane, "chat_id", "")).strip()
        thread_id = getattr(lane, "thread_id", None)
        task_id = str(task_id).strip()
        if not lane_id or not chat_id or thread_id is None or not task_id:
            return False
        event_key = f"{lane_id}:{task_id}:{event}"
        now = time.time()
        with self._connect() as db:
            if event in TERMINAL_EVENTS:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute(
                    "SELECT event FROM telegram_events WHERE lane_id=? AND task_id=? AND event IN (?,?,?,?,?,?) LIMIT 1",
                    (lane_id, task_id, *sorted(TERMINAL_EVENTS)),
                ).fetchone()
                if existing:
                    db.commit()
                    return False
            cursor = db.execute(
                """INSERT OR IGNORE INTO telegram_events
                   (event_key,lane_id,task_id,event,preview,chat_id,thread_id,state,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,'pending',?,?)""",
                (event_key, lane_id, task_id, event, sanitize_preview(preview), chat_id,
                 str(thread_id), now, now),
            )
            inserted = cursor.rowcount == 1
            db.commit()
        if inserted:
            self._wake.set()
        return inserted

    def enqueue_async(self, lane, event: str, *, task_id: str, preview: str) -> Future:
        if self._closed:
            future: Future = Future()
            future.set_result(False)
            return future
        def isolated() -> bool:
            try:
                return self.enqueue(lane, event, task_id=task_id, preview=preview)
            except Exception:
                logger.exception("hermes-gemini-live: Telegram enqueue failed for %s", task_id)
                return False
        return self._executor.submit(isolated)

    def pending(self) -> list[dict]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT event_key,lane_id,task_id,event,preview,state FROM telegram_events "
                "WHERE state != 'delivered' ORDER BY created_at,event_key"
            ).fetchall()
        return [dict(row) for row in rows]

    def deliver_once(self) -> int:
        delivered = 0
        while True:
            with self._connect() as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute(
                    "UPDATE telegram_events SET state='retry' WHERE state='sending' AND updated_at<?",
                    (time.time() - self.lease_seconds,),
                )
                row = db.execute(
                    "SELECT * FROM telegram_events WHERE state IN ('pending','retry') "
                    "ORDER BY created_at,event_key LIMIT 1"
                ).fetchone()
                if row is None:
                    db.commit()
                    break
                cursor = db.execute(
                    "UPDATE telegram_events SET state='sending',updated_at=? WHERE event_key=? AND state IN ('pending','retry')",
                    (time.time(), row["event_key"]),
                )
                db.commit()
                if cursor.rowcount != 1:
                    continue
            try:
                success = self.sender({
                    "action": "send",
                    "target": f"telegram:{row['chat_id']}:{row['thread_id']}",
                    "message": _message(row["event"], row["preview"]),
                })
            except Exception:
                logger.exception("hermes-gemini-live: Telegram delivery failed for %s", row["event_key"])
                success = False
            now = time.time()
            with self._connect() as db:
                if success:
                    cursor = db.execute(
                        "UPDATE telegram_events SET state='delivered',updated_at=?,last_error='' "
                        "WHERE event_key=? AND state != 'delivered'", (now, row["event_key"]),
                    )
                    delivered += cursor.rowcount
                else:
                    db.execute(
                        "UPDATE telegram_events SET state='retry',attempts=attempts+1,updated_at=? "
                        "WHERE event_key=?", (now, row["event_key"]),
                    )
        return delivered

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="gml-telegram-mirror", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=max(1.0, self.poll_seconds * 2))
            if self._thread.is_alive():
                logger.warning("hermes-gemini-live: Telegram mirror worker did not stop before timeout")
        if self._thread and not self._thread.is_alive():
            self._thread = None

    def close(self) -> None:
        self.stop()
        self._closed = True
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _run(self) -> None:
        while True:
            if self._stop.is_set():
                break
            try:
                self.deliver_once()
            except Exception:
                logger.exception("hermes-gemini-live: Telegram mirror worker failed")
            self._wake.wait(self.poll_seconds)
            self._wake.clear()

    def _init_db(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute(
                """CREATE TABLE IF NOT EXISTS telegram_events (
                    event_key TEXT PRIMARY KEY,
                    lane_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    event TEXT NOT NULL,
                    preview TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    thread_id TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('pending','retry','sending','delivered')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )"""
            )
            db.execute("UPDATE telegram_events SET state='retry' WHERE state='sending'")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db
