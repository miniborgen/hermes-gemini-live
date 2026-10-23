from __future__ import annotations

from fastapi.testclient import TestClient

from hermes_gemini_live import mobile_app, telegram_mirror


LOGIN = "owner@example.com"
HEADERS = {"Tailscale-User-Login": LOGIN}


def test_app_lifecycle_starts_and_stops_telegram_delivery(tmp_path, monkeypatch):
    events = []
    mirror = telegram_mirror.TelegramMirror(tmp_path / "mirror.sqlite3", sender=lambda payload: True)
    monkeypatch.setattr(mirror, "start", lambda: events.append("start"))
    monkeypatch.setattr(mirror, "stop", lambda: events.append("stop"))

    with TestClient(mobile_app.create_app(allowed_login=LOGIN, mirror=mirror)) as client:
        assert client.get("/health", headers=HEADERS).status_code == 200

    assert events == ["start", "stop"]


def test_task_store_persists_sanitized_snapshot_across_instances(tmp_path):
    store = mobile_app.TaskSnapshotStore(tmp_path / "tasks.sqlite3")
    store.upsert("browser-1", "garage-r129", {
        "id": "task-1", "title": "Read /Users/me/private", "state": "working",
        "startedAt": 10, "updatedAt": 20, "laneId": "garage-r129", "laneName": "Garage R129",
        "question": "", "preview": "https://private.example",
    })
    restored = mobile_app.TaskSnapshotStore(tmp_path / "tasks.sqlite3").snapshot("browser-1", "garage-r129")
    assert restored[0]["id"] == "task-1"
    assert "/Users/" not in restored[0]["title"]
    assert "https://" not in restored[0]["preview"]


def test_task_store_partial_update_preserves_existing_context(tmp_path):
    store = mobile_app.TaskSnapshotStore(tmp_path / "tasks.sqlite3")
    store.upsert("browser-1", "garage-r129", {
        "id": "task-1", "title": "Inspect hydraulic roof", "state": "working",
        "startedAt": 10, "updatedAt": 20, "laneId": "garage-r129", "laneName": "Garage R129",
        "question": "Check the pump?", "preview": "Initial inspection",
    })
    store.upsert("browser-1", "garage-r129", {
        "id": "task-1", "state": "cancelled", "updatedAt": 30,
    })
    restored = store.snapshot("browser-1", "garage-r129")[0]
    assert restored["title"] == "Inspect hydraulic roof"
    assert restored["startedAt"] == 10
    assert restored["laneName"] == "Garage R129"
    assert restored["question"] == "Check the pump?"
    assert restored["preview"] == "Initial inspection"
    assert restored["state"] == "cancelled"


def test_removed_inbox_routes_are_not_exposed(tmp_path):
    mirror = telegram_mirror.TelegramMirror(tmp_path / "mirror.sqlite3", sender=lambda payload: True)
    with TestClient(mobile_app.create_app(allowed_login=LOGIN, mirror=mirror)) as client:
        assert client.get("/api/lanes/personal-assistant/events", headers=HEADERS).status_code == 404
        assert client.post(
            "/api/lanes/personal-assistant/events/event-1/ack", headers=HEADERS
        ).status_code in {404, 405}


def test_test_notification_can_bypass_visible_only_guard_without_weakening_normal_notifications():
    app = (mobile_app._MOBILE_ROOT / "app.js").read_text()
    assert "showTaskNotification (frame, { allowVisible = false } = {})" in app
    assert "(!allowVisible && document.visibilityState === 'visible')" in app
    assert "showTaskNotification({ type: 'task_done', id: 'test'" in app
    assert "}, { allowVisible: true })" in app


def test_output_mute_silences_feedback_audio_but_not_microphone_logic():
    app = (mobile_app._MOBILE_ROOT / "app.js").read_text()
    assert "state.soundCues && !state.outputMuted" in app
    assert "shouldTransmitMic" in app


def test_orb_has_three_visual_task_rings_and_semantic_fallback():
    html = (mobile_app._MOBILE_ROOT / "index.html").read_text()
    app = (mobile_app._MOBILE_ROOT / "app.js").read_text()
    assert 'id="task-rings"' in html
    assert 'aria-hidden="true"' in html
    assert "className = 'task-orbit-item'" in app
    assert "className = 'task-orbit-text'" in app
    assert "radialTaskCards(state.tasks" in app
    assert "state.displayMode !== 'orb'" in app
    assert "formatElapsed(task.elapsedSeconds)" in app
    assert 'id="task-cards" class="task-cards" role="list"' in html
    assert "card.setAttribute('role', 'listitem')" in app
    assert "elements.taskCards.hidden = !showTaskDetails" in app


def test_webgl_presence_asset_is_served_and_cached():
    html = (mobile_app._MOBILE_ROOT / "index.html").read_text()
    sw = (mobile_app._MOBILE_ROOT / "sw.js").read_text()
    assert 'id="presence-canvas"' in html
    assert "./presence-webgl.mjs" in sw
    response = TestClient(mobile_app.create_app(allowed_login=LOGIN)).get(
        "/presence-webgl.mjs", headers=HEADERS
    )
    assert response.status_code == 200
    assert "createPresenceRenderer" in response.text


def test_webgl_initialization_failure_keeps_the_css_presence_fallback():
    renderer = (mobile_app._MOBILE_ROOT / "presence-webgl.mjs").read_text()
    app = (mobile_app._MOBILE_ROOT / "app.js").read_text()
    assert "function unavailableRenderer" in renderer
    assert "catch (error)" in renderer
    assert "canvas.classList.remove('ember-organism')" in renderer
    assert "const presence = createPresenceRenderer" in app


def test_service_worker_uses_network_first_for_the_navigation_shell():
    sw = (mobile_app._MOBILE_ROOT / "sw.js").read_text()
    assert "request.mode === 'navigate'" in sw
    assert "fetch(request, { cache: 'no-store' })" in sw
    assert "cache.put('./', copy)" in sw


def test_radial_tasks_stop_under_reduced_motion_and_scale_for_small_screens():
    css = (mobile_app._MOBILE_ROOT / "styles.css").read_text()
    assert ".task-orbit-item" in css
    assert "@media (max-width: 390px)" in css
    assert "@media (prefers-reduced-motion: reduce)" in css
    assert ".task-orbit-item { transition: none !important;" in css


def test_orb_task_labels_stay_short_and_do_not_overlap_the_detail_cards():
    css = (mobile_app._MOBILE_ROOT / "styles.css").read_text()
    app = (mobile_app._MOBILE_ROOT / "app.js").read_text()
    assert ".task-orbit-item {" in css
    assert "rotate(calc(var(--task-angle) * 1deg))" in css
    assert "rotate(calc(var(--task-angle) * -1deg))" in css
    assert "translateX(var(--task-radius))" in css
    assert "px`)" in app
    assert "[data-working=\"true\"] .orb::before" not in css
    assert "task.shortTitle" in app
    assert "task.state === 'completed'" in app
    assert "task.state === 'cancelled'" in app
    assert "renderTaskOrbit(Date.now())" in app
    assert "[data-display=\"orb\"] .task-cards" in css
    assert "display: none" in css
