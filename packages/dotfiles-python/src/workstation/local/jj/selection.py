import datetime as dt
import re
import shutil
import sys
from dataclasses import dataclass
from typing import cast

import questionary
from rich.text import Text

from workstation.errors import DotfilesError

from .repository import log as _log
from .settings import settings as _settings

_INSTRUCTION = "(↑↓ move · space toggle · enter confirm)"
_STYLE = questionary.Style([
    ("qmark", "fg:ansimagenta bold"),
    ("question", "bold"),
    ("answer", "fg:ansimagenta bold"),
    ("pointer", "fg:ansimagenta bold"),
    ("selected", "fg:ansimagenta bold"),
    ("instruction", "fg:ansibrightblack"),
    ("validation-toolbar", "fg:ansired"),
    ("redate-working-copy", "fg:ansimagenta bold"),
    ("redate-change", "fg:ansicyan bold"),
    ("redate-empty", "fg:ansibrightblack italic"),
    ("redate-time", "fg:ansibrightblack"),
])


@dataclass(frozen=True, slots=True)
class RedateItem:
    change: str
    marker: str
    short_change: str
    email: str
    timestamp: str
    short_commit: str
    summary: str

    @property
    def revset(self) -> str:
        return f"change_id({self.change})"


def _redate_selectable_revset() -> str:
    return _settings().jj_redate_revset


def _redate_selectable_limit() -> int | None:
    return _settings().jj_redate_limit


def _prompt(label: str, default: str) -> str:
    if (
        not _settings().jj_redate_no_prompt
        and sys.stdin.isatty()
        and sys.stdout.isatty()
    ):
        result = questionary.text(
            label.strip().removesuffix(":"),
            default=default,
            qmark="◆",
            style=_STYLE,
        ).ask()
        if result is None:
            raise DotfilesError(f"no input received for {label}")
        return result
    try:
        return input(label) or default
    except EOFError:
        if sys.stdin.isatty():
            return default
        raise DotfilesError(f"no input received for {label}") from None


def _timestamp() -> str:
    now = dt.datetime.now().astimezone()
    date_value = _prompt("Date (YYYY-MM-DD): ", now.strftime("%Y-%m-%d"))
    time_value = _prompt("Time (HH[:MM[:SS]]): ", now.strftime("%H:%M:%S"))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_value):
        raise DotfilesError(f"invalid date: {date_value!r}")
    if re.fullmatch(r"\d{1,2}", time_value):
        time_value += ":00:00"
    elif re.fullmatch(r"\d{1,2}:\d{2}", time_value):
        time_value += ":00"
    elif not re.fullmatch(r"\d{1,2}:\d{2}:\d{2}", time_value):
        raise DotfilesError(f"invalid time: {time_value!r}")
    try:
        value = dt.datetime.strptime(
            f"{date_value} {time_value}", "%Y-%m-%d %H:%M:%S"
        ).astimezone()
    except ValueError as error:
        raise DotfilesError(str(error)) from error
    return value.isoformat(timespec="seconds")


def _confirm_redate(revisions: list[str], timestamp: str) -> bool:
    if len(revisions) == 1:
        label = revisions[0]
        if match := re.fullmatch(r"change_id\(([^)]+)\)", label):
            label = f"change {match[1][:8]}"
    else:
        label = f"{len(revisions)} revisions"
    if (
        not _settings().jj_redate_no_prompt
        and sys.stdin.isatty()
        and sys.stdout.isatty()
    ):
        return bool(
            questionary.confirm(
                f"Redate {label} to {timestamp}?",
                qmark="◆",
                style=_STYLE,
            ).ask()
        )
    print(f"Redating {label} to {timestamp}", file=sys.stderr)
    return True


def _redate_selectable_items(revset: str, limit: int | None) -> list[RedateItem]:
    template = (
        'change_id ++ "\\t" ++ '
        'if(current_working_copy, "@", "") ++ "\\t" ++ '
        'change_id.shortest(8) ++ "\\t" ++ '
        'author.email() ++ "\\t" ++ '
        'committer.timestamp().format("%Y-%m-%d %H:%M:%S") ++ "\\t" ++ '
        'commit_id.shortest(8) ++ "\\t" ++ '
        'description.first_line() ++ "\\n"'
    )
    items: list[RedateItem] = []
    selectable_revset = f"latest(({revset}), {limit})" if limit else revset
    for line in _log(selectable_revset, template).splitlines():
        fields = line.split("\t", 6)
        if len(fields) != 7:
            continue
        change, marker, short_change, email, timestamp, short_commit, description = (
            fields
        )
        summary = " ".join(description.split()) or "(no description set)"
        items.append(
            RedateItem(
                change=change,
                marker=marker,
                short_change=short_change,
                email=email,
                timestamp=timestamp,
                short_commit=short_commit,
                summary=summary,
            )
        )
    return items


def _friendly_redate_timestamp(value: str) -> str:
    timestamp = dt.datetime.strptime(value, "%Y-%m-%d %H:%M:%S").astimezone()
    today = dt.datetime.now().astimezone().date()
    if timestamp.date() == today:
        return f"today {timestamp:%H:%M}"
    if timestamp.date() == today - dt.timedelta(days=1):
        return f"yesterday {timestamp:%H:%M}"
    if timestamp.year == today.year:
        return timestamp.strftime("%b %d %H:%M")
    return timestamp.strftime("%Y-%m-%d")


def _truncate_redate_summary(value: str, width: int) -> str:
    text = Text(value, no_wrap=True, overflow="ellipsis")
    text.truncate(max(width, 1), overflow="ellipsis")
    return text.plain


def _redate_choice_title(
    item: RedateItem, terminal_columns: int
) -> list[tuple[str, str]]:
    available = max(terminal_columns - 7, 13)
    marker = f"{item.marker} " if item.marker else "  "
    prefix_width = Text(marker + item.short_change + "  ").cell_len
    friendly_time = _friendly_redate_timestamp(item.timestamp)
    show_time = available >= 60
    time_width = Text(friendly_time).cell_len + 2 if show_time else 0
    summary_width = max(available - prefix_width - time_width, 1)
    summary = _truncate_redate_summary(item.summary, summary_width)
    summary_padding = max(summary_width - Text(summary).cell_len, 0)
    summary_style = (
        "class:redate-empty" if item.summary == "(no description set)" else "class:text"
    )
    title = [
        ("class:redate-working-copy", marker),
        ("class:redate-change", item.short_change),
        ("class:text", "  "),
        (summary_style, summary),
    ]
    if show_time:
        title.extend([
            ("class:text", " " * (summary_padding + 2)),
            ("class:redate-time", friendly_time),
        ])
    return title


def _redate_choices(items: list[RedateItem]) -> list[questionary.Choice]:
    terminal_columns = shutil.get_terminal_size(fallback=(100, 24)).columns
    return [
        questionary.Choice(
            title=_redate_choice_title(item, terminal_columns),
            value=item.revset,
            description=(
                f"{item.email}  ·  commit {item.short_commit}  ·  {item.timestamp}"
            ),
        )
        for item in items
    ]


def _interactive_redate_revisions() -> list[str] | None:
    if (
        _settings().jj_redate_no_prompt
        or not sys.stdin.isatty()
        or not sys.stdout.isatty()
    ):
        return None
    revset = _redate_selectable_revset()
    limit = _redate_selectable_limit()
    items = _redate_selectable_items(revset, limit)
    if not items:
        raise DotfilesError(f"jj-redate: no revisions matched {revset!r}")
    selected = questionary.checkbox(
        f"Select revisions ({len(items)} available)",
        choices=_redate_choices(items),
        qmark="◆",
        pointer=">",
        instruction=_INSTRUCTION,
        style=_STYLE,
        validate=lambda choices: bool(choices) or "Select at least one revision",
    )
    revisions = selected.ask()
    if revisions is None:
        return []
    if revisions:
        return cast("list[str]", revisions)
    raise DotfilesError("jj-redate: no revisions selected")


def _redate_revisions(revisions: list[str]) -> list[str]:
    if revisions:
        return revisions
    selected = _interactive_redate_revisions()
    return ["@"] if selected is None else selected
