"""Voice swim lanes derived from Hermes' Telegram topic bindings.

A lane is selected by a public, stable slug. Its trusted context is resolved server-side
from the topic's bound skill and the canonical GBrain markdown paths named by that skill.
The browser receives selector metadata only, never the assembled prompt.
"""

from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_INSTRUCTIONS_CHARS = 15000
MAX_SOURCE_CHARS = 7000
MAX_SKILL_CHARS = 8000
_INTERESTING_HEADINGS = (
    "overview", "vehicle identity", "current state", "decisions", "assistant-facing",
    "open loops", "active threads", "current install", "core policy", "when to use",
)
_VOICE_PRIORITY_HEADINGS = (
    "purpose", "when to use", "scope", "safety", "privacy", "consent", "approval",
    "confirmation", "operating", "policy", "rules", "workflow", "process", "recovery",
    "pitfall", "verification", "boundary", "guardrail", "identity",
)
_RULE_LINE = re.compile(
    r"\b(must|never|do not|don't|confirm|verify|only|avoid|stop|privacy|consent|approval|"
    r"sender|recipient|credential|secret|purchase|delete|failure|recover)\b", re.I,
)


def _home() -> Path:
    configured = (os.environ.get("HERMES_HOME") or "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".hermes"


def _slug(name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return value or "lane"


def _mapping_block(
    lines: list[str], key: str, start: int, end: int, parent_indent: int,
) -> tuple[int, int, int] | None:
    direct_indents = [
        len(line) - len(line.lstrip()) for line in lines[start:end]
        if line.strip() and not line.lstrip().startswith("#")
        and len(line) - len(line.lstrip()) > parent_indent
    ]
    if not direct_indents:
        return None
    direct_indent = min(direct_indents)
    match_index = next((
        index for index in range(start, end)
        if len(lines[index]) - len(lines[index].lstrip()) == direct_indent
        and re.match(rf"^\s*{re.escape(key)}:\s*$", lines[index])
    ), None)
    if match_index is None:
        return None
    block_end = end
    for index in range(match_index + 1, end):
        line = lines[index]
        if line.strip() and len(line) - len(line.lstrip()) <= direct_indent:
            block_end = index
            break
    return match_index, block_end, direct_indent


def _topic_rows() -> list[dict[str, Any]]:
    path = _home() / "config.yaml"
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return []
    telegram = _mapping_block(lines, "telegram", 0, len(lines), -1)
    if telegram is None:
        return []
    extra = _mapping_block(lines, "extra", telegram[0] + 1, telegram[1], telegram[2])
    if extra is None:
        return []
    group = _mapping_block(lines, "group_topics", extra[0] + 1, extra[1], extra[2])
    if group is None:
        return []
    scoped = lines[group[0] + 1:group[1]]

    topics: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    item_indent = -1
    current_chat = ""
    for line in scoped:
        chat = re.match(r"^\s*- chat_id:\s*(.+?)\s*$", line)
        if chat:
            if current:
                topics.append(current)
                current = None
            current_chat = _yaml_scalar(chat.group(1))
            continue
        match = re.match(r"^(\s*)- name:\s*(.+?)\s*$", line)
        if match and current_chat:
            if current:
                topics.append(current)
            item_indent = len(match.group(1))
            current = {"name": _yaml_scalar(match.group(2)), "chat_id": current_chat}
            continue
        if current is None:
            continue
        field = re.match(r"^(\s*)(thread_id|skill):\s*(.+?)\s*$", line)
        if field and len(field.group(1)) > item_indent:
            current[field.group(2)] = _yaml_scalar(field.group(3))
        elif line.strip() and len(line) - len(line.lstrip()) <= item_indent:
            topics.append(current)
            current = None
    if current:
        topics.append(current)
    rows: list[dict[str, Any]] = []
    used: set[str] = set()
    for topic in topics:
        name = topic.get("name", "").strip()
        skill = topic.get("skill", "").strip()
        chat_id = topic.get("chat_id", "").strip()
        try:
            thread_id = int(topic.get("thread_id", ""))
        except ValueError:
            continue
        if not name or not skill or not chat_id:
            continue
        lane_id = _slug(name)
        if lane_id in used:
            lane_id = f"{lane_id}-{_slug(chat_id)}-{thread_id}"
        used.add(lane_id)
        rows.append({"id": lane_id, "name": name, "chat_id": chat_id,
                     "thread_id": thread_id, "skill": skill})
    return rows


def _yaml_scalar(value: str) -> str:
    text = value.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        return text[1:-1]
    return text


def list_lanes() -> list[dict[str, Any]]:
    """Safe selector metadata for every readable skill-bound Telegram topic."""
    return [{"id": row["id"], "name": row["name"]}
            for row in _topic_rows() if _readable_skill(row["skill"]) is not None]


def _skill_file(skill: str) -> Path | None:
    roots = [_home() / "skills"]
    default_root = Path.home() / ".hermes" / "skills"
    if default_root not in roots:
        roots.append(default_root)
    for root in roots:
        direct = root / skill / "SKILL.md"
        if direct.is_file():
            return direct
        if root.is_dir():
            matches = list(root.glob(f"**/{skill}/SKILL.md"))
            if matches:
                return matches[0]
    return None


def _readable_skill(skill: str) -> tuple[Path, str] | None:
    path = _skill_file(skill)
    if path is None:
        return None
    try:
        if not stat.S_IMODE(path.stat().st_mode) & 0o444:
            return None
        return path, path.read_text()
    except OSError:
        return None


def _canonical_paths(skill_text: str) -> list[Path]:
    found: list[Path] = []
    canonical = False
    collected = False
    for line in skill_text.splitlines():
        lower = line.strip().lower()
        rejected = any(label in lower for label in (
            "non-canonical", "noncanonical", "not canonical", "not a canonical",
            "isn't canonical", "related page", "related context", "related source",
        ))
        if lower.startswith("#"):
            canonical = (
                not rejected and "canonical" in lower
                and any(word in lower for word in ("page", "context", "index", "source"))
            )
            collected = False
        if rejected:
            canonical = False
            continue
        if (
            "canonical" in lower
            and any(word in lower for word in ("page", "context", "index", "source"))
        ):
            canonical = True
        elif canonical and collected and lower and not lower.startswith(("-", "`")):
            canonical = False
        if not canonical:
            continue
        for raw in re.findall(r"~/(?:brain|\.hermes)/[^`\s]+\.md", line):
            path = Path(raw).expanduser()
            if path not in found and path.is_file():
                found.append(path)
                collected = True
    return found[:4]


def _bounded(text: str, limit: int) -> str:
    value = text.strip()
    if len(value) <= limit:
        return value
    cut = value.rfind("\n", 0, limit)
    return value[:cut if cut > 0 else limit].rstrip()


def _voice_brief(skill_text: str, limit: int = MAX_SKILL_CHARS) -> str:
    """Keep a full short skill or a marked, safety-aware brief from a long skill."""
    value = skill_text.strip()
    if len(value) <= limit:
        return value
    sections: list[tuple[str, list[str]]] = []
    heading = "Skill identity"
    body: list[str] = []
    for line in value.splitlines():
        if re.match(r"^#{1,3}\s+", line):
            if body:
                sections.append((heading, body))
            heading, body = line, []
        else:
            body.append(line)
    if body:
        sections.append((heading, body))

    selected: list[str] = []
    for index, (title, lines) in enumerate(sections):
        lower = title.lower()
        if index == 0 or any(word in lower for word in _VOICE_PRIORITY_HEADINGS):
            kept = [line for line in lines if (
                line.lstrip().startswith(("- ", "* "))
                or re.match(r"^\s*\d+[.)]\s", line)
                or _RULE_LINE.search(line)
            )]
            if not kept:
                kept = lines[:8] + (lines[-4:] if len(lines) > 12 else [])
            selected.append("\n".join([title, *kept]).strip())

    marker = (
        "[Voice brief selected from a longer skill. Hermes must load the full bound skill "
        "before delegated actions; this excerpt does not replace it.]"
    )
    parts = [marker, *[part for part in selected if part]]
    joined = "\n\n".join(parts)
    if len(joined) <= limit:
        return joined
    section_count = len(selected)
    if not section_count:
        return marker[:limit]
    separator_chars = 2 * section_count
    available = max(0, limit - len(marker) - separator_chars)
    per_part = max(1, available // section_count)
    bounded: list[str] = []
    notice = "\n[section condensed for voice]\n"
    for part in selected:
        if len(part) <= per_part:
            bounded.append(part)
            continue
        title, _, section_body = part.partition("\n")
        if len(title) >= per_part:
            bounded.append(title[:per_part])
            continue
        body_budget = per_part - len(title) - 1
        if body_budget <= len(notice):
            bounded.append((title + "\n" + section_body[:body_budget])[:per_part])
            continue
        content_budget = body_budget - len(notice)
        head = max(1, int(content_budget * 0.68))
        tail = max(0, content_budget - head)
        condensed = section_body[:head].rstrip() + notice + (section_body[-tail:].lstrip() if tail else "")
        bounded.append((title + "\n" + condensed)[:per_part])
    return "\n\n".join([marker, *bounded])


def _useful_markdown(text: str, limit: int = MAX_SOURCE_CHARS) -> str:
    """Keep identity, current state and open loops; omit large archives and raw histories."""
    if limit <= 0:
        return ""
    lines = text.splitlines()
    selected: list[str] = []
    active = False
    saw_heading = False
    for line in lines:
        if line.startswith("## "):
            saw_heading = True
            heading = line[3:].strip().lower()
            active = any(key in heading for key in _INTERESTING_HEADINGS)
        elif line.startswith("# ") and not saw_heading:
            active = True
        if active or (not saw_heading and len(selected) < 30):
            selected.append(line)
        if len("\n".join(selected)) >= limit:
            break
    value = "\n".join(selected).strip()
    return value[:limit]


def _lane_behavior_profile(name: str, skill: str) -> dict[str, str]:
    """Return conservative voice behavior directives from trusted lane identity."""
    identity = f"{name} {skill}".lower()
    if any(token in identity for token in ("garage", "operator", "ops", "pilot")):
        return {
            "archetype": "operator",
            "initiative": "suggestive",
            "delegation_style": "evidence-first",
            "voice_style": "concise and operational",
        }
    if any(token in identity for token in ("research", "valuation", "sourcing")):
        return {
            "archetype": "researcher",
            "initiative": "suggestive",
            "delegation_style": "evidence-first",
            "voice_style": "concise and exploratory",
        }
    if any(token in identity for token in ("personal assistant", "family", "calendar", "appointment")):
        return {
            "archetype": "personal_assistant",
            "initiative": "proactive-with-confirmation",
            "delegation_style": "action-first",
            "voice_style": "concise and helpful",
        }
    return {
        "archetype": "mixed",
        "initiative": "reactive",
        "delegation_style": "clarify-first",
        "voice_style": "concise and exploratory",
    }


def _behavior_section(name: str, skill: str) -> str:
    profile = _lane_behavior_profile(name, skill)
    return "Lane behavior profile:\n" + "\n".join(
        f"- {key}: {value}" for key, value in profile.items()
    )


@dataclass(frozen=True)
class VoiceLane:
    id: str
    name: str
    chat_id: str
    thread_id: int
    skill: str
    instructions: str
    task_context: str

    def session_key(self, base: str | None) -> str:
        prefix = (base or "gemini-live").strip().rstrip(":")
        return f"{prefix}:chat:{self.chat_id}:topic:{self.thread_id}"


def resolve_lane(lane_id: str | None) -> VoiceLane | None:
    requested = str(lane_id or "").strip()
    row = next((item for item in _topic_rows() if item["id"] == requested), None)
    if row is None:
        return None
    skill = _readable_skill(row["skill"])
    if skill is None:
        return None
    _skill_path, skill_text = skill
    sources = _canonical_paths(skill_text)
    preamble = (
        f"Selected swim lane: {row['name']}. This is a focused working conversation, not a "
        "general chat. Use the trusted lane context below to answer directly from the lane "
        "context when it contains the answer. Do not say you lack information that is present "
        "here, and do not delegate simple recall or discussion. Delegate to Hermes only for "
        "current facts, deeper retrieval, files, tools, research, or actions. Keep confirmed "
        "facts separate from hypotheses. Follow every safety, privacy, consent, and operating "
        "rule present in the bounded voice brief below. For delegated work, Hermes must load and "
        f"follow the complete lane skill {row['skill']}. "
        "Speak English by default. If the user is clearly speaking Swedish, switch naturally "
        "to Swedish; English and Swedish are the only languages you may select automatically. "
        "Use Spanish or any other language only when the user explicitly asks to switch. If "
        "language is ambiguous, stay in the current language. When delegating longer work, "
        "acknowledge it once and continue the conversation naturally without polling, repeating "
        "the task, or ending every reply with a generic invitation. Return to queued results at "
        "the next conversational opening."
    )
    skill_section = _voice_brief(skill_text, MAX_SKILL_CHARS)
    behavior_section = _behavior_section(row["name"], row["skill"])
    fixed = "\n\n".join([
        preamble,
        behavior_section,
        f"Lane voice brief:\n{skill_section}",
    ])
    remaining = max(0, MAX_INSTRUCTIONS_CHARS - len(fixed) - 2)
    per_source = min(MAX_SOURCE_CHARS, remaining // max(1, len(sources)))
    source_sections: list[str] = []
    included: list[Path] = []
    for path in sources:
        try:
            useful = _useful_markdown(path.read_text(), max(0, per_source - 40))
        except OSError:
            continue
        if useful:
            source_sections.append(f"Canonical context from {path.name}:\n{useful}")
            included.append(path)
    assembled = "\n\n".join([fixed, *source_sections])
    paths = ", ".join(str(path) for path in included) or "no canonical page resolved"
    task_context = (
        f"Voice lane {row['name']}; Telegram chat {row['chat_id']} topic {row['thread_id']}; "
        f"load/follow skill {row['skill']}; canonical context: {paths}. "
        "Answer within this lane and write durable decisions or open loops back through the "
        "lane's normal GBrain workflow when appropriate."
    )
    return VoiceLane(
        id=row["id"], name=row["name"], chat_id=row["chat_id"],
        thread_id=row["thread_id"], skill=row["skill"],
        instructions=assembled, task_context=task_context,
    )
