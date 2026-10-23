"""Private mobile web surface for the Gemini Live relay.

The server binds to loopback and is intended to sit behind Tailscale Serve. Tailscale
removes client-supplied identity headers and injects the authenticated tailnet identity,
so the browser never receives a reusable application secret.
"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import os
import sqlite3
import threading
import time
from collections.abc import Mapping
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse

from . import config, lanes, relay, telegram_mirror

_NO_STORE = {"Cache-Control": "no-store"}
_SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; "
        "style-src 'self'; script-src 'self'; worker-src 'self'; media-src 'self' blob:; "
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    ),
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}
_USER_HEADER = "tailscale-user-login"
_MOBILE_ROOT = Path(__file__).resolve().parent.parent / "mobile"
_ASSETS = {
    "app.js": "application/javascript",
    "state.mjs": "application/javascript",
    "presence-webgl.mjs": "application/javascript",
    "audio-worklet.js": "application/javascript",
    "styles.css": "text/css",
    "sw.js": "application/javascript",
    "manifest.webmanifest": "application/manifest+json",
    "fonts/source-serif-4.woff2": "font/woff2",
    "fonts/inter.woff2": "font/woff2",
    "fonts/jetbrains-mono.woff2": "font/woff2",
    "icons/icon-192.png": "image/png",
    "icons/icon-512.png": "image/png",
}


class TaskSnapshotStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS task_snapshots (
                scope TEXT NOT NULL, lane_id TEXT NOT NULL, task_id TEXT NOT NULL,
                payload TEXT NOT NULL, updated_at REAL NOT NULL,
                PRIMARY KEY(scope,lane_id,task_id))""")

    def _connect(self):
        return sqlite3.connect(self.path, timeout=5)

    def upsert(self, scope: str, lane_id: str, task: dict) -> None:
        task_id = str(task.get("id") or "")[:128]
        if not scope or not task_id:
            return
        previous: dict = {}
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT payload FROM task_snapshots WHERE scope=? AND lane_id=? AND task_id=?",
                (scope[:128], lane_id[:128], task_id),
            ).fetchone()
            if row:
                previous = json.loads(row[0])
        safe = {
            "id": task_id,
            "title": relay._result_preview(str(task.get("title") or task.get("prompt") or previous.get("title") or "Delegated task"), 96),
            "state": str(task.get("state") or previous.get("state") or "working")[:32],
            "startedAt": float(task.get("startedAt") or previous.get("startedAt") or time.time() * 1000),
            "updatedAt": float(task.get("updatedAt") or time.time() * 1000),
            "laneId": str(task.get("laneId") or previous.get("laneId") or lane_id)[:128],
            "laneName": relay._result_preview(str(task.get("laneName") or previous.get("laneName") or ""), 64),
            "question": relay._result_preview(str(task.get("question", previous.get("question", ""))), 180) if task.get("question", previous.get("question")) else "",
            "preview": relay._result_preview(str(task.get("preview", previous.get("preview", ""))), 180) if task.get("preview", previous.get("preview")) else "",
        }
        with self._lock, self._connect() as db:
            db.execute("INSERT OR REPLACE INTO task_snapshots(scope,lane_id,task_id,payload,updated_at) VALUES(?,?,?,?,?)",
                       (scope[:128], lane_id[:128], safe["id"], json.dumps(safe), time.time()))

    def upsert_async(self, scope: str, lane_id: str, task: dict):
        return asyncio.to_thread(self.upsert, scope, lane_id, task)

    def snapshot(self, scope: str, lane_id: str) -> list[dict]:
        with self._lock, self._connect() as db:
            rows = db.execute("SELECT payload FROM task_snapshots WHERE scope=? AND lane_id=? ORDER BY updated_at DESC LIMIT 32",
                              (scope[:128], lane_id[:128])).fetchall()
        return [json.loads(row[0]) for row in rows]


def _identity_allowed(headers: Mapping[str, str], allowed_login: str) -> bool:
    presented = str(headers.get(_USER_HEADER, "")).strip().lower()
    expected = allowed_login.strip().lower()
    return bool(expected and presented and hmac.compare_digest(presented, expected))


def _loopback(host: str | None) -> bool:
    try:
        return bool(host and ipaddress.ip_address(host).is_loopback)
    except ValueError:
        return False


def _asset_response(name: str) -> FileResponse:
    media_type = _ASSETS.get(name)
    target = (_MOBILE_ROOT / name).resolve()
    if media_type is None or not target.is_relative_to(_MOBILE_ROOT.resolve()) or not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(target, media_type=media_type, headers=_NO_STORE)


def _home() -> Path:
    configured = (os.environ.get("HERMES_HOME") or "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".hermes"


def create_app(*, allowed_login: str,
               mirror: telegram_mirror.TelegramMirror | None = None,
               task_store: TaskSnapshotStore | None = None) -> FastAPI:
    mirror = mirror or telegram_mirror.TelegramMirror(
        _home() / "state" / "mini-live-telegram.sqlite3")
    task_store = task_store or TaskSnapshotStore(_home() / "state" / "mini-live-tasks.sqlite3")

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        mirror.start()
        try:
            yield
        finally:
            mirror.close()

    app = FastAPI(title="Mini Live Mobile", docs_url=None, redoc_url=None,
                  lifespan=lifespan)

    @app.middleware("http")
    async def require_tailnet_identity(request: Request, call_next):
        client_host = request.client.host if request.client else None
        if not (_loopback(client_host) or _identity_allowed(request.headers, allowed_login)):
            return JSONResponse({"detail": "Forbidden"}, status_code=403, headers=_NO_STORE)
        response = await call_next(request)
        response.headers.setdefault("Cache-Control", "no-store")
        for name, value in _SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        return response

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {"ok": True, "service": "hermes-gemini-live-mobile"}

    @app.get("/status")
    async def status() -> dict[str, object]:
        payload = config.status_dict()
        payload["push"] = False
        return payload

    @app.get("/lanes")
    async def voice_lanes() -> dict[str, object]:
        return {"lanes": lanes.list_lanes()}


    @app.websocket("/relay")
    async def live_relay(ws: WebSocket) -> None:
        client_host = ws.client.host if ws.client else None
        if not (_loopback(client_host) or _identity_allowed(ws.headers, allowed_login)):
            await ws.close(code=4403)
            return
        lane_id = str(ws.query_params.get("lane") or "").strip()
        continuity_key = str(ws.query_params.get("call") or "").strip()[:128] or None
        conversation_key = str(ws.query_params.get("conversation") or "").strip()[:128] or continuity_key

        voice = str(ws.query_params.get("voice") or "").strip()
        if voice not in {"Aoede", "Kore", "Puck", "Charon", "Fenrir"}:
            voice = None
        voice_lane = lanes.resolve_lane(lane_id) if lane_id else None
        if lane_id and voice_lane is None:
            await ws.close(code=4404)
            return
        await ws.accept()
        try:
            await relay.run_relay(
                ws,
                session_key=config.api_server_session_key(),
                profile=config.serving_profile(),
                voice_lane=voice_lane,
                continuity_key=continuity_key,
                voice=voice,
                mirror=mirror,
                task_store=task_store,
                conversation_key=conversation_key,
            )
        except WebSocketDisconnect:
            pass
        finally:
            try:
                await ws.close()
            except Exception:
                pass

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(_MOBILE_ROOT / "index.html", media_type="text/html", headers=_NO_STORE)

    @app.get("/favicon.ico")
    async def favicon() -> FileResponse:
        return FileResponse(_MOBILE_ROOT / "icons" / "icon-192.png", media_type="image/png", headers=_NO_STORE)

    @app.get("/{asset_path:path}")
    async def asset(asset_path: str) -> FileResponse:
        return _asset_response(asset_path)

    return app
