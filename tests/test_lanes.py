from __future__ import annotations

from pathlib import Path

from hermes_gemini_live import lanes


def _home(tmp_path: Path) -> Path:
    home = tmp_path / ".hermes"
    skill = home / "skills" / "garage-r129-lane"
    skill.mkdir(parents=True)
    brain = tmp_path / "brain" / "projects" / "garage"
    brain.mkdir(parents=True)
    (home / "config.yaml").write_text("""other:
  group_topics:
    - chat_id: '-9999'
      topics:
        - name: Wrong lane
          thread_id: 1
          skill: garage-r129-lane
telegram:
  extra:
    group_topics:
      - chat_id: '-1001'
        topics:
          - name: Garage — R129
            thread_id: 68
            skill: garage-r129-lane
unrelated:
  - name: Not a Telegram lane
    thread_id: 68
    skill: garage-r129-lane
""")
    (skill / "SKILL.md").write_text(
        "---\nname: garage-r129-lane\n---\n# R129 lane\n"
        "## Purpose\nFocused R129 work.\n"
        "## Privacy and consent rules\nNever authorize purchases without confirmation.\n"
        "Canonical page: `~/brain/projects/garage/r129.md`\n"
        "Related page: `~/brain/projects/garage/private.md`\n"
        "Non-canonical page: `~/brain/projects/garage/private.md`\n"
        "## Operating rules\nVerify vehicle-specific facts before purchases.\n"
    )
    (brain / "r129.md").write_text(
        "# R129\n\n## Vehicle identity\n- 1994 Mercedes-Benz SL500\n\n"
        "## Current state / decisions\n- OVP relay is not applicable.\n\n"
        "## Assistant-facing open loops\n- [ ] Inspect the lower engine harness.\n\n"
        "## Huge archive\n" + ("ignore me\n" * 2000)
    )
    (brain / "private.md").write_text("# Private\n\n## Current state\n- unrelated bank account detail\n")
    return home


def test_lanes_follow_telegram_topic_bindings_and_build_a_bounded_voice_brief(tmp_path, monkeypatch):
    home = _home(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path))

    found = lanes.list_lanes()

    assert found == [{
        "id": "garage-r129",
        "name": "Garage — R129",
    }]
    lane = lanes.resolve_lane("garage-r129")
    assert lane is not None
    assert "1994 Mercedes-Benz SL500" in lane.instructions
    assert "OVP relay is not applicable" in lane.instructions
    assert "Inspect the lower engine harness" in lane.instructions
    assert "Never authorize purchases without confirmation" in lane.instructions
    assert "Verify vehicle-specific facts before purchases" in lane.instructions
    assert "unrelated bank account detail" not in lane.instructions
    assert "answer directly from the lane context" in lane.instructions
    assert len(lane.instructions) < 16000
    assert lane.session_key(None) == "gemini-live:chat:-1001:topic:68"
    assert lane.session_key("voice") == "voice:chat:-1001:topic:68"
    assert "garage-r129-lane" in lane.task_context


def test_unknown_or_unbound_lanes_are_rejected(tmp_path, monkeypatch):
    home = _home(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path))

    assert lanes.resolve_lane("not-a-real-lane") is None


def test_late_safety_sections_survive_a_large_skill_without_silent_cutoff(tmp_path, monkeypatch):
    home = _home(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path))
    skill = home / "skills" / "garage-r129-lane" / "SKILL.md"
    skill.write_text(
        "# Large lane\n\n## Implementation notes\n" + ("routine detail\n" * 1000) +
        "\n## Privacy and consent rules\nNever send a message or buy anything without confirmation.\n"
        "\n## Verification checklist\n- Confirm the exact target before acting.\n"
    )

    lane = lanes.resolve_lane("garage-r129")

    assert lane is not None
    assert "Never send a message or buy anything without confirmation" in lane.instructions
    assert "Confirm the exact target before acting" in lane.instructions
    assert "Voice brief selected from a longer skill" in lane.instructions


def test_many_priority_sections_each_remain_represented_in_voice_brief(tmp_path, monkeypatch):
    home = _home(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path))
    skill = home / "skills" / "garage-r129-lane" / "SKILL.md"
    skill.write_text("# Large lane\n\n" + "\n\n".join(
        f"## Safety rule {index}\nmarker-{index}: NEVER skip this confirmation.\n" +
        ("- NEVER bypass the exact approval target or privacy boundary.\n" * 24)
        for index in range(40)
    ))

    lane = lanes.resolve_lane("garage-r129")

    assert lane is not None
    assert "marker-0" in lane.instructions
    assert "marker-20" in lane.instructions
    assert "marker-39" in lane.instructions
    assert len(lane.instructions) <= lanes.MAX_INSTRUCTIONS_CHARS


def test_unreadable_skill_is_not_advertised(tmp_path, monkeypatch):
    home = _home(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path))
    skill = home / "skills" / "garage-r129-lane" / "SKILL.md"
    skill.chmod(0)

    assert lanes.list_lanes() == []
    assert lanes.resolve_lane("garage-r129") is None
