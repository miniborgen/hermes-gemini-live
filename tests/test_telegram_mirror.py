from __future__ import annotations

import threading
import time

from hermes_gemini_live import telegram_mirror


class Lane:
    id = "garage-r129"
    chat_id = "trusted-chat"
    thread_id = 68


def test_outbox_persists_unique_events_and_redacts_sensitive_preview(tmp_path):
    outbox = telegram_mirror.TelegramMirror(tmp_path / "mirror.sqlite3", sender=lambda payload: True)

    assert outbox.enqueue(Lane(), "started", task_id="task-1", preview="token=secret /Users/example/private.txt") is True
    assert outbox.enqueue(Lane(), "started", task_id="task-1", preview="duplicate") is False

    rows = outbox.pending()
    assert len(rows) == 1
    assert rows[0]["event_key"] == "garage-r129:task-1:started"
    assert rows[0]["state"] == "pending"
    assert "secret" not in rows[0]["preview"]
    assert "/Users/" not in rows[0]["preview"]


def test_delivery_survives_restart_and_marks_event_delivered(tmp_path):
    path = tmp_path / "mirror.sqlite3"
    first = telegram_mirror.TelegramMirror(path, sender=lambda payload: False)
    first.enqueue(Lane(), "needs_input", task_id="task-2", preview="Approve the safe command")

    sent = []
    second = telegram_mirror.TelegramMirror(path, sender=lambda payload: sent.append(payload) or True)
    assert second.deliver_once() == 1
    assert sent[0]["target"] == "telegram:trusted-chat:68"
    assert "needs your input" in sent[0]["message"]
    assert second.pending() == []


def test_terminal_states_are_distinct_across_tasks_and_deduplicated(tmp_path):
    outbox = telegram_mirror.TelegramMirror(tmp_path / "mirror.sqlite3", sender=lambda payload: True)

    states = ("completed", "failed", "cancelled", "interrupted", "timed_out", "unavailable")
    for index, state in enumerate(states):
        task_id = f"task-{index}"
        assert outbox.enqueue(Lane(), state, task_id=task_id, preview=state) is True
        assert outbox.enqueue(Lane(), state, task_id=task_id, preview="again") is False

    assert {row["event"] for row in outbox.pending()} == set(states)


def test_enqueue_never_calls_slow_sender_on_caller_thread(tmp_path):
    called = threading.Event()

    def slow_sender(payload):
        called.set()
        time.sleep(0.2)
        return True

    outbox = telegram_mirror.TelegramMirror(tmp_path / "mirror.sqlite3", sender=slow_sender)
    started = time.monotonic()
    outbox.enqueue(Lane(), "started", task_id="task-4", preview="work")
    elapsed = time.monotonic() - started

    assert elapsed < 0.1
    assert called.is_set() is False


def test_atomic_claim_allows_only_one_concurrent_sender(tmp_path):
    sent = []
    barrier = threading.Barrier(2)

    def sender(payload):
        sent.append(payload)
        time.sleep(0.05)
        return True

    path = tmp_path / "mirror.sqlite3"
    first = telegram_mirror.TelegramMirror(path, sender=sender)
    second = telegram_mirror.TelegramMirror(path, sender=sender)
    first.enqueue(Lane(), "started", task_id="atomic", preview="work")

    def deliver(mirror):
        barrier.wait()
        mirror.deliver_once()

    threads = [threading.Thread(target=deliver, args=(mirror,)) for mirror in (first, second)]
    for thread in threads: thread.start()
    for thread in threads: thread.join()
    assert len(sent) == 1


def test_enqueue_async_isolates_database_failure_from_audio_loop(tmp_path, monkeypatch):
    outbox = telegram_mirror.TelegramMirror(tmp_path / "mirror.sqlite3", sender=lambda payload: True)
    monkeypatch.setattr(outbox, "enqueue", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("disk full")))
    future = outbox.enqueue_async(Lane(), "started", task_id="isolated", preview="work")
    assert future.result(timeout=1) is False


def test_terminal_outcome_supersedes_contradictory_terminal_events(tmp_path):
    outbox = telegram_mirror.TelegramMirror(tmp_path / "mirror.sqlite3", sender=lambda payload: True)
    assert outbox.enqueue(Lane(), "completed", task_id="terminal", preview="done") is True
    assert outbox.enqueue(Lane(), "failed", task_id="terminal", preview="late failure") is False
    assert [row["event"] for row in outbox.pending()] == ["completed"]


def test_terminal_outcome_insert_is_atomic_across_concurrent_writers(tmp_path):
    path = tmp_path / "mirror.sqlite3"
    first = telegram_mirror.TelegramMirror(path, sender=lambda payload: True)
    second = telegram_mirror.TelegramMirror(path, sender=lambda payload: True)
    barrier = threading.Barrier(2)
    results = []

    def enqueue(mirror, event):
        barrier.wait()
        results.append(mirror.enqueue(Lane(), event, task_id="terminal-race", preview=event))

    threads = [threading.Thread(target=enqueue, args=(first, "completed")),
               threading.Thread(target=enqueue, args=(second, "failed"))]
    for thread in threads: thread.start()
    for thread in threads: thread.join()

    assert sorted(results) == [False, True]
    assert len(first.pending()) == 1


def test_stop_keeps_live_worker_reference_and_prevents_concurrent_restart(tmp_path):
    entered = threading.Event()
    release = threading.Event()

    def hanging_sender(payload):
        entered.set()
        release.wait(2)
        return True

    outbox = telegram_mirror.TelegramMirror(
        tmp_path / "mirror.sqlite3", sender=hanging_sender, poll_seconds=0.01)
    outbox.enqueue(Lane(), "started", task_id="hung", preview="work")
    outbox.start()
    assert entered.wait(1)
    original = outbox._thread
    outbox.stop()

    assert outbox._thread is original
    assert outbox.running is True
    outbox.start()
    assert outbox._thread is original
    release.set()
    original.join(1)


def test_stale_sending_claim_is_recovered_without_duplicate_live_delivery(tmp_path):
    path = tmp_path / "mirror.sqlite3"
    sent = []
    outbox = telegram_mirror.TelegramMirror(path, sender=lambda payload: sent.append(payload) or True,
                                            lease_seconds=0.01)
    outbox.enqueue(Lane(), "started", task_id="leased", preview="work")
    with outbox._connect() as db:
        db.execute("UPDATE telegram_events SET state='sending',updated_at=?", (time.time() - 1,))

    assert outbox.deliver_once() == 1
    assert len(sent) == 1


def test_redaction_covers_bearer_auth_ipv4_and_windows_paths():
    value = telegram_mirror.sanitize_preview(
        r"Authorization: Bearer abcdef1234567890 C:\\Users\\Example\\secret.txt 192.168.1.55"
    )
    assert "abcdef" not in value
    assert "Example" not in value
    assert "192.168" not in value


def test_background_worker_delivers_and_stops_cleanly(tmp_path):
    delivered = threading.Event()
    outbox = telegram_mirror.TelegramMirror(
        tmp_path / "mirror.sqlite3", sender=lambda payload: delivered.set() or True,
        poll_seconds=0.01,
    )
    outbox.enqueue(Lane(), "started", task_id="task-5", preview="work")

    outbox.start()
    assert delivered.wait(1)
    outbox.stop()

    assert outbox.running is False
    assert outbox.pending() == []


def test_close_stops_worker_and_shuts_down_enqueue_executor(tmp_path):
    outbox = telegram_mirror.TelegramMirror(tmp_path / "mirror.sqlite3", sender=lambda payload: True)
    outbox.start()
    outbox.close()
    assert outbox.running is False
    future = outbox.enqueue_async(Lane(), "started", task_id="closed", preview="work")
    assert future.result(timeout=1) is False
