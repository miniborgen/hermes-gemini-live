"""Private mobile web surface for the Gemini Live relay.

The server binds to loopback and is intended to sit behind Tailscale Serve. Tailscale
removes client-supplied identity headers and injects the authenticated tailnet identity,
so the browser never receives a reusable application secret.
"""

from __future__ import annotations

import hmac
import ipaddress
from collections.abc import Mapping
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse

from . import config, lanes, relay

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


def create_app(*, allowed_login: str) -> FastAPI:
    app = FastAPI(title="Mini Live Mobile", docs_url=None, redoc_url=None)

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
        return config.status_dict()

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
