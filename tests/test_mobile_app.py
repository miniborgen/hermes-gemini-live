from __future__ import annotations

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from hermes_gemini_live import mobile_app
from hermes_gemini_live.mobile_app import create_app


LOGIN = "magnus.borg@gmail.com"
HEADERS = {"Tailscale-User-Login": LOGIN}


def client() -> TestClient:
    return TestClient(create_app(allowed_login=LOGIN))


def test_status_reports_web_push_unavailable_until_server_keys_are_configured(monkeypatch):
    monkeypatch.setattr(mobile_app.config, "status_dict", lambda: {"ok": True})
    response = client().get("/status", headers=HEADERS)
    assert response.json()["push"] is False


def test_mute_and_spoken_welcome_behavior_are_wired_into_the_browser_shell():
    app_script = client().get("/app.js", headers=HEADERS).text
    assert "player?.setMuted(state.muted)" in app_script
    assert "gain.gain.setValueAtTime(muted ? 0 : 1" in app_script
    assert "localStorage.setItem('hermes-live-captions', 'on')" in app_script
    assert "Captions stay on while voice is muted" in app_script
    assert "type: 'text', text: welcomeText" in app_script
    assert "if (!state.muted && socket?.readyState === WebSocket.OPEN)" in app_script


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
    assert "Mini Live" in response.text
    assert "Hermes Live" not in response.text
    assert 'id="orb"' in response.text
    assert 'id="presence-canvas"' in response.text
    assert 'id="start-call"' in response.text
    assert 'id="approval-sheet"' in response.text
    assert 'id="lane-select"' in response.text
    assert 'id="captions-call"' in response.text
    assert 'id="live-caption"' in response.text
    assert 'id="view-cycle"' in response.text
    assert 'id="view-cycle-label"' in response.text
    assert 'id="view-cycle-next"' in response.text
    assert 'id="view-orb"' not in response.text
    assert 'id="highlight-stack"' in response.text
    assert 'id="word-stream"' in response.text

    assert 'id="highlight-announcer"' in response.text
    assert 'id="highlight-stack" class="highlight-stack" role="button" tabindex="0" aria-live=' not in response.text
    assert '<section class="stage" aria-live=' not in response.text
    assert 'class="status-copy orb-status"' in response.text
    assert '<div class="status-copy session-status">' not in response.text
    assert 'id="status-label" aria-live="polite"' in response.text
    assert 'id="barge-in"' in response.text
    assert "Barge in" in response.text
    assert ">Interrupt<" not in response.text
    assert "Stable speaker" not in response.text
    assert "Natural barge-in" not in response.text
    assert 'id="sound-cues"' in response.text
    assert 'id="voice-select"' in response.text
    assert 'id="notifications"' in response.text
    assert 'id="drawer-toggle"' in response.text
    assert 'id="settings-drawer"' in response.text
    assert 'id="current-lane"' in response.text
    assert 'class="call-meta"' in response.text
    assert 'id="top-elapsed"' in response.text
    assert 'id="top-lane"' in response.text
    assert 'id="elapsed" class="elapsed sr-only">0:00</span>' in response.text
    assert 'class="orb-glow"' in response.text
    assert 'id="top-working-status" class="top-working-status" hidden' in response.text
    assert 'id="top-working-text"' in response.text
    assert response.text.index('id="live-caption"') < response.text.index('id="call-controls"')
    assert 'class="control-icon mute-icon"' in response.text
    assert 'class="control-icon voice-mute-icon"' in response.text
    assert 'class="orb-disc"' in response.text
    assert 'class="sigil-lobe' not in response.text
    assert 'class="drawer-control-label"' in response.text
    assert 'id="barge-state"' in response.text
    assert 'id="sound-state"' in response.text
    assert 'class="app-version"' in response.text
    assert '>v63<' in response.text
    assert 'drawer-hint-chip' not in response.text
    assert '<span class="drawer-hint-label">Settings</span>' not in response.text
    assert 'id="drawer-toggle" class="call-meta"' in response.text
    assert 'id="drawer-dismiss"' in response.text
    assert '<button id="drawer-toggle" class="drawer-hint' not in response.text
    assert 'class="brand"' not in response.text
    assert 'class="topbar-status"' not in response.text
    assert "One-off chat" in response.text
    assert response.text.count(" switch") >= 2
    app_script = client().get("/app.js", headers=HEADERS).text
    assert "url.searchParams.set('call', `${callId}:lane:${conversationScope}`)" in app_script
    assert "const conversationScope = state.selectedLane || 'one-off'" in app_script
    assert "frame.welcome === 'resumed'" in app_script
    assert "Hey, I’m back." in app_script
    assert "Hey, what can we do?" in app_script
    assert "frame.statusText = frame.welcome === 'resumed' ? 'Conversation resumed' : 'Session ready'" in app_script
    assert "const showCaptions = captions.length > 0" in app_script
    assert "caption.speaker === 'user' ? 'You' : 'Mini'" in app_script
    assert "elements.captions.querySelector('span:last-child').textContent = 'Captions'" in app_script
    assert "Captions on" not in app_script
    assert "caption.speaker === 'user' ? 'You' : 'Gemini'" not in app_script
    assert "state.displayMode === 'orb' && captions.length > 0" not in app_script
    assert "showToast(welcomeText)" not in app_script
    assert "url.searchParams.set('conversation', callId)" in app_script
    assert 'rel="manifest"' in response.text

    styles = client().get("/styles.css", headers=HEADERS).text
    assert '.word-stream { position: absolute;' in styles
    assert '.word-stream-user { top: 31%;' in styles
    assert '.word-stream-assistant { top: 68%;' in styles
    assert '.word-stream-lane { position: absolute; left: 50%; width: 100%;' in styles
    assert 'top: 68%' in styles
    assert 'translateX(calc(-50% - 22vw))' in styles
    assert 'translateX(calc(-50% - 44vw))' in styles
    assert 'font-size: clamp(24px, 7vw, 38px)' in styles
    assert '.stream-word[data-age="0"] { animation:' not in styles
    assert '@keyframes stream-exit' not in styles
    assert '[data-stream-complete="true"] .stream-word' in styles
    assert '@keyframes stream-finish' in styles
    assert 'height: 100%;' in styles
    assert '#app[data-session="idle"] .session-status { bottom: 62px;' in styles
    assert '#app[data-session="idle"] .status-copy h1' in styles and 'font-size: 15px' in styles
    assert '#app[data-session="idle"] .status-copy p' in styles and 'font-size: 11px' in styles
    assert '[data-working="true"] .status-copy p { display: inline-flex; align-items: center;' in styles
    assert "ambient-drift" in styles
    assert 'font-family: "Source Serif 4"' in styles
    assert 'font-family: "Inter"' in styles
    assert 'font-family: "JetBrains Mono"' in styles
    assert "url('./fonts/source-serif-4.woff2')" in styles
    assert "url('./fonts/inter.woff2')" in styles
    assert "url('./fonts/jetbrains-mono.woff2')" in styles
    assert "baseFrequency='.38'" in styles
    assert ".end-control .control-icon" in styles
    assert "#app[data-display=\"text\"] .highlight-stack" in styles
    assert ".call-meta" in styles
    assert ".session-status" in styles
    assert ".orb-glow" in styles
    assert ".orb-disc" in styles
    assert "linear-gradient(to bottom, transparent 0, #000 14%" in styles
    assert "width: min(68vw, 270px)" in styles
    assert "font-size: clamp(2.8rem, 12vw, 5.25rem)" in styles
    assert "orb-soft-pulse" in styles
    assert '[data-session="live"][data-voice="assistant"] .orb { filter: saturate(1.32) brightness(1.16);' in styles
    assert '[data-session="live"][data-voice="assistant"] .orb-glow { opacity: calc(.82 + var(--level, 0) * .18);' in styles
    assert '[data-session="live"][data-voice="assistant"] .orb-disc { filter: brightness(1.42) saturate(1.24);' in styles
    assert "task-orbit-title" in styles
    assert "task-orbit-meta" in styles
    assert "task-halo-arrive" in styles
    assert "task-orbit-complete" in styles
    assert "text-overflow: ellipsis" not in styles[styles.index('.task-orbit-text'):styles.index('.task-orbit-item[data-state=\"completed\"]')]
    assert "sigil-bloom" not in styles
    assert "background: transparent" in styles
    assert "background: radial-gradient(circle at 42% 36%" in styles
    assert '.live-caption { position: relative; z-index: 7;' in styles
    assert 'width: min(100%, 520px)' in styles
    assert 'margin: 0 auto 2px' in styles
    assert 'background: rgba(9,5,4,.16)' in styles
    assert '.session-status { position: absolute' in styles
    assert ".button-primary { background: rgba(9,6,5,.08)" in styles
    assert '.highlight-speaker::after { content: none;' in styles
    assert '.highlight-item[data-speaker="user"] { padding-right: 28px;' in styles
    assert '.highlight-item[data-speaker="assistant"] { padding-left: 28px;' in styles
    assert '.highlight-item[data-speaker="user"] p { color: rgba(211,139,91,.78);' in styles
    assert '.highlight-item[data-speaker="assistant"] p { color: rgba(240,229,219,.9);' in styles
    assert '[data-display="text"] .session-status { bottom: calc(var(--bottom-reserve) - 34px);' in styles
    assert '[data-display="text"] .status-copy h1 { color: rgba(229,217,207,.38); font-size: 13px;' in styles
    assert 'align-items: center; gap: 10px;' in styles
    assert '#app[data-session="idle"] .session-status { bottom: 62px;' in styles
    assert 'color: rgba(229,217,207,.38)' in styles
    assert 'background: rgba(18,13,11,.34)' in styles
    assert 'backdrop-filter: blur(30px) saturate(1.25)' in styles
    assert '.drawer-lane-picker { width: min(100%, 330px); justify-self: center;' in styles
    assert '.drawer-dismiss { justify-self: center;' in styles
    assert '.call-meta { position: absolute; z-index: 3; top: 24px;' in styles
    assert '[data-display="text"] .status-copy h1 { color: rgba(229,217,207,.38); font-size: 13px;' in styles
    assert '[data-working="true"] .session-status { bottom: calc(var(--bottom-reserve) - 82px);' in styles
    assert '[data-working="true"] .status-copy h1 { font-size: 24px;' in styles
    assert '#app[data-session="live"][data-working="false"] .orb-status h1' in styles
    assert '[data-working="true"] .elapsed { display: none;' in styles
    assert '.top-working-status { position: absolute;' in styles
    assert '.top-working-spinner { width: 10px;' in styles
    assert '.orb-status { position: absolute;' in styles
    assert '.session-status { position: absolute; width: 1px; height: 1px;' in styles
    assert '[data-display="orb"][data-working="true"] .session-status h1 { visibility: hidden;' in styles
    assert '.control-icon { display: inline-flex;' in styles
    assert '.mute-icon { transform: translateY(-.25px);' in styles
    assert '.voice-mute-icon { transform: translateX(.75px);' in styles
    assert '.round-control { display: flex;' in styles and 'background: rgba(9,6,5,.015)' in styles
    assert '.round-control .control-label { white-space: nowrap;' in styles
    assert '.end-control { border-color: rgba(207,101,85,.06);' in styles
    assert 'animation: task-label-breathe 2.8s ease-in-out infinite;' in styles
    assert 'animation: task-dot-pulse 1.7s ease-in-out infinite;' in styles
    assert 'animation: task-text-drift 2.8s ease-in-out infinite;' in styles
    assert '@keyframes task-dot-pulse' in styles


    app = client().get("/app.js", headers=HEADERS).text
    assert "elements.highlightStack.setAttribute('role', state.highlights.length ? 'list' : 'button')" in app
    assert "createPresenceRenderer" in app
    assert "naturalSpeechGate(naturalGate" in app
    assert "item.setAttribute('role', 'listitem')" in app
    assert "elements.highlightStack.setAttribute('tabindex', state.highlights.length ? '-1' : '0')" in app
    assert "setText(elements.topElapsed" in app
    assert "elements.topWorkingStatus.hidden = state.pending.length === 0" in app
    assert "'Working on one task for you'" in app
    assert "setText(elements.topLane" in app
    assert "setText(elements.bargeState, state.duplexMode === 'natural' ? 'Barging' : 'Stable')" in app
    assert "setText(elements.soundState, state.soundCues ? 'Sound on' : 'Muted')" in app
    assert "elements.captions.hidden = state.displayMode !== 'orb'" in app
    assert "item.dataset.speaker = highlight.speaker" in app
    assert "marker.textContent = highlight.speaker === 'assistant' ? 'M' : highlight.speaker === 'user' ? 'Y' : ''" in app
    assert "Listening for the shape of the conversation" not in app
    assert "document.addEventListener('pointerdown'" in app
    assert "elements.drawerDismiss.addEventListener('click'" in app
    assert "updateViaCache: 'none'" in app
    assert "registration.update()" in app
    assert "navigator.serviceWorker.addEventListener('controllerchange'" in app
    assert "function applyPendingWorkerRefresh" in app
    assert "pendingWorkerRefresh = true" in app
    assert "if (['starting', 'live', 'reconnecting'].includes(state.session)) return" in app
    assert "elements.liveCaption.replaceChildren()" in app
    assert "streamWords: []" in app
    assert "streamSources: { user: '', assistant: '' }" in app
    assert "elements.wordStream.replaceChildren" in app
    assert "Notification.requestPermission()" in app
    assert "document.visibilityState === 'visible'" in app
    assert "registration.showNotification" in app
    assert "try {" in app and "catch {}" in app
    assert "'Notification' in window" in app
    assert "navigator.wakeLock.request('screen')" in app
    assert "document.visibilityState !== 'visible'" in app
    assert "function releaseWakeLock" in app
    assert "syncWakeLock()" in app
    assert "state = reduceFrame(state, frame)\n  player?.setMuted(state.muted)\n  syncWakeLock()" in app
    assert "void requestWakeLock()" in app
    assert "releaseWakeLock()" in app
    assert "window.addEventListener('pagehide', handlePageHide)" in app
    assert "window.addEventListener('pageshow', handlePageShow)" in app


def test_manifest_is_scoped_as_a_standalone_ios_pwa():
    response = client().get("/manifest.webmanifest", headers=HEADERS)

    assert response.status_code == 200
    manifest = response.json()
    assert manifest["display"] == "standalone"
    assert manifest["start_url"] == "./"
    assert manifest["scope"] == "./"
    assert manifest["theme_color"] == "#050403"
    assert manifest["name"] == "Mini Live"
    assert manifest["short_name"] == "Mini Live"
    assert {icon["sizes"] for icon in manifest["icons"]} >= {"192x192", "512x512"}
    assert client().get("/favicon.ico", headers=HEADERS).headers["content-type"].startswith("image/png")


def test_service_worker_never_caches_api_or_relay_traffic():
    response = client().get("/sw.js", headers=HEADERS)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert "request.url.includes('/relay')" in response.text
    assert "request.url.includes('/api/')" in response.text
    assert "request.url.includes('/status')" in response.text
    assert "request.url.includes('/lanes')" in response.text
    assert "cache: 'no-store'" in response.text
    assert "notificationclick" in response.text
    assert "clients.matchAll" in response.text
    assert "event.notification.data?.url" in response.text
    assert client().get("/state.mjs", headers=HEADERS).headers["content-type"].startswith("application/javascript")


def test_ride_brief_fonts_are_self_hosted_with_correct_content_types():
    for path in (
        "/fonts/source-serif-4.woff2",
        "/fonts/inter.woff2",
        "/fonts/jetbrains-mono.woff2",
    ):
        response = client().get(path, headers=HEADERS)
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("font/woff2")
        assert response.headers["cache-control"] == "no-store"


def test_status_reports_readiness_without_exposing_key_material(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "private-test-key-1234")

    response = client().get("/status", headers=HEADERS)

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert "private-test-key" not in response.text


def test_lanes_endpoint_returns_only_safe_selector_metadata(monkeypatch):
    monkeypatch.setattr(mobile_app.lanes, "list_lanes", lambda: [{
        "id": "garage-r129", "name": "Garage — R129",
    }])

    response = client().get("/lanes", headers=HEADERS)

    assert response.status_code == 200
    assert response.json() == {"lanes": [{
        "id": "garage-r129", "name": "Garage — R129",
    }]}
    assert "instructions" not in response.text
    assert "thread_id" not in response.text
    assert "skill" not in response.text


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
    seen = {}

    class Lane:
        id = "garage-r129"

    async def fake_relay(ws, session_key=None, profile=None, voice_lane=None, **kwargs):
        seen["lane"] = voice_lane
        await ws.send_json({"type": "ready", "lane": voice_lane.id})

    monkeypatch.setattr(mobile_app.relay, "run_relay", fake_relay)
    monkeypatch.setattr(mobile_app.lanes, "resolve_lane", lambda lane_id: Lane() if lane_id == "garage-r129" else None)

    with client() as http:
        with http.websocket_connect("/relay?lane=garage-r129", headers=HEADERS) as ws:
            assert ws.receive_json() == {"type": "ready", "lane": "garage-r129"}
    assert seen["lane"].id == "garage-r129"


def test_relay_without_a_lane_opens_a_regular_context_free_conversation(monkeypatch):
    seen = {}

    async def fake_relay(ws, session_key=None, profile=None, voice_lane=None, **kwargs):
        seen["lane"] = voice_lane
        await ws.send_json({"type": "ready"})

    monkeypatch.setattr(mobile_app.relay, "run_relay", fake_relay)
    monkeypatch.setattr(
        mobile_app.lanes,
        "resolve_lane",
        lambda lane_id: (_ for _ in ()).throw(AssertionError("missing lane must not be resolved")),
    )

    with client() as http:
        with http.websocket_connect("/relay", headers=HEADERS) as ws:
            assert ws.receive_json() == {"type": "ready"}
    assert seen["lane"] is None


def test_relay_rejects_an_unknown_lane_before_opening_gemini(monkeypatch):
    monkeypatch.setattr(mobile_app.lanes, "resolve_lane", lambda lane_id: None)

    with client() as http:
        try:
            with http.websocket_connect("/relay?lane=missing", headers=HEADERS):
                raise AssertionError("unknown lane was accepted")
        except WebSocketDisconnect as exc:
            assert exc.code == 4404
