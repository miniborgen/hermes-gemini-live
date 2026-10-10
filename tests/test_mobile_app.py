from __future__ import annotations

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from hermes_gemini_live import mobile_app
from hermes_gemini_live.mobile_app import create_app


LOGIN = "magnus.borg@gmail.com"
HEADERS = {"Tailscale-User-Login": LOGIN}


def client() -> TestClient:
    return TestClient(create_app(allowed_login=LOGIN))


def test_health_reports_ready_for_the_allowed_tailnet_identity():
    response = client().get("/health", headers=HEADERS)

    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "hermes-gemini-live-mobile"}
    assert response.headers["cache-control"] == "no-store"


def test_remote_request_without_the_allowed_tailnet_identity_is_refused():
    http = client()

    assert http.get("/health").status_code == 403
    assert http.get("/health", headers={"Tailscale-User-Login": "someone@example.com"}).status_code == 403


def test_root_serves_the_installable_mobile_call_surface():
    response = client().get("/", headers=HEADERS)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-store"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "Gemini Live" in response.text
    assert 'id="orb"' in response.text
    assert 'id="start-call"' in response.text
    assert 'id="approval-sheet"' in response.text
    assert 'rel="manifest"' in response.text


def test_manifest_is_scoped_as_a_standalone_ios_pwa():
    response = client().get("/manifest.webmanifest", headers=HEADERS)

    assert response.status_code == 200
    manifest = response.json()
    assert manifest["display"] == "standalone"
    assert manifest["start_url"] == "./"
    assert manifest["scope"] == "./"
    assert manifest["theme_color"] == "#050403"
    assert {icon["sizes"] for icon in manifest["icons"]} >= {"192x192", "512x512"}
    assert client().get("/favicon.ico", headers=HEADERS).headers["content-type"].startswith("image/png")


def test_service_worker_never_caches_api_or_relay_traffic():
    response = client().get("/sw.js", headers=HEADERS)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert "request.url.includes('/relay')" in response.text
    assert "request.url.includes('/api/')" in response.text
    assert "cache: 'no-store'" in response.text
    assert client().get("/state.mjs", headers=HEADERS).headers["content-type"].startswith("application/javascript")


def test_status_reports_readiness_without_exposing_key_material(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "private-test-key-1234")

    response = client().get("/status", headers=HEADERS)

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert "private-test-key" not in response.text


def test_relay_refuses_a_remote_identity_other_than_the_allowlisted_user():
    with client() as http:
        try:
            with http.websocket_connect(
                "/relay", headers={"Tailscale-User-Login": "someone@example.com"}
            ):
                raise AssertionError("unauthorized websocket was accepted")
        except WebSocketDisconnect as exc:
            assert exc.code == 4403


def test_relay_accepts_the_allowlisted_tailnet_user_and_runs_the_existing_relay(monkeypatch):
    async def fake_relay(ws, session_key=None, profile=None):
        await ws.send_json({"type": "ready"})

    monkeypatch.setattr(mobile_app.relay, "run_relay", fake_relay)

    with client() as http:
        with http.websocket_connect("/relay", headers=HEADERS) as ws:
            assert ws.receive_json() == {"type": "ready"}
