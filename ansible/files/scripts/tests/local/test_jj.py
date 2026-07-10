from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from workstation.local import jj as jj_module
from workstation.local.jj import (
    jj_get_entrypoint,
    jj_git_fetch_entrypoint,
    jj_redate_entrypoint,
)


class Tty:
    def isatty(self) -> bool:
        return True


def test_jj_get_help_does_not_require_a_repository(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["jj-get", "--help"])

    jj_get_entrypoint()

    assert capsys.readouterr().out.startswith("usage: jj-get")


@pytest.mark.parametrize(
    "arguments",
    [
        ["123", "owner/repo", "ignored"],
        ["https://github.com/owner/repo/pull/123", "ignored"],
    ],
)
def test_jj_get_rejects_extra_pr_arguments(
    monkeypatch: pytest.MonkeyPatch, arguments: list[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["jj-get", *arguments])

    with pytest.raises(SystemExit, match="usage: jj-get"):
        jj_get_entrypoint()


def test_jj_get_rejects_base_after_remote_in_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["jj-get", "feature@upstream", "main", "ignored"],
    )

    with pytest.raises(SystemExit, match="usage: jj-get"):
        jj_get_entrypoint()


def test_jj_get_accepts_pr_url_query(monkeypatch: pytest.MonkeyPatch) -> None:
    resolved: list[tuple[str, str | None]] = []
    monkeypatch.setattr(
        sys,
        "argv",
        ["jj-get", "https://github.com/owner/repo/pull/123?notification_referrer=1"],
    )
    monkeypatch.setattr(jj_module, "_git", lambda *_args, **_kwargs: ".git")
    monkeypatch.setattr(
        jj_module,
        "_resolve_pr",
        lambda number, repo: resolved.append((number, repo)),
    )

    jj_get_entrypoint()

    assert resolved == [("123", "owner/repo")]


def test_git_commands_use_jj_workspace_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[tuple[str, ...], bool, str | None]] = []
    workspace_root = str(tmp_path / "example-workspace")

    def fake_output(argv: tuple[str, ...], *, check: bool, cwd: str | None) -> str:
        calls.append((argv, check, cwd))
        return "false"

    monkeypatch.setenv("JJ_WORKSPACE_ROOT", workspace_root)
    monkeypatch.setattr(jj_module, "output", fake_output)

    assert not jj_module._shallow()
    assert calls == [
        (
            ("git", "rev-parse", "--is-shallow-repository"),
            False,
            workspace_root,
        )
    ]


def test_unchanged_shallow_boundary_skips_reindex(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(jj_module, "_shallow_boundary", lambda: "unchanged")
    monkeypatch.setattr(
        jj_module,
        "run",
        lambda *_args, **_kwargs: pytest.fail("reindex should be skipped"),
    )

    jj_module._reindex_if_shallow_boundary_changed("unchanged")


def test_jj_get_shallow_branch_fetches_only_stack_and_diff_base(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[tuple[str, ...], dict[str, object]]] = []
    workspace_root = str(tmp_path / "example-workspace")

    def fake_run(argv: tuple[str, ...], **kwargs: object) -> object:
        calls.append((argv, kwargs))
        return object()

    monkeypatch.setenv("JJ_WORKSPACE_ROOT", workspace_root)
    monkeypatch.setattr(jj_module, "_shallow", lambda: True)

    def fake_git(*args: str, **_kwargs: object) -> str:
        if args == ("remote", "get-url", "origin"):
            return "git@example.com:owner/repo.git"
        if args == (
            "rev-list",
            "--count",
            "refs/remotes/origin/feature",
        ):
            return "3"
        raise AssertionError(args)

    monkeypatch.setattr(jj_module, "_git", fake_git)
    monkeypatch.setattr(jj_module, "run", fake_run)
    boundaries = iter(["old-boundary", "new-boundary"])
    monkeypatch.setattr(jj_module, "_shallow_boundary", lambda: next(boundaries))
    tracked: list[tuple[str, str]] = []
    monkeypatch.setattr(
        jj_module,
        "_track_remote_bookmark",
        lambda bookmark, remote: tracked.append((bookmark, remote)),
    )

    jj_module._resolve_branch("feature", "origin", "main")

    refspec = "+refs/heads/feature:refs/remotes/origin/feature"
    assert calls == [
        (
            (
                "git",
                "fetch",
                "--shallow-exclude=refs/heads/main",
                "--prune",
                "--no-write-fetch-head",
                "--no-tags",
                "--",
                "origin",
                refspec,
            ),
            {"cwd": workspace_root},
        ),
        (
            (
                "git",
                "fetch",
                "--depth=4",
                "--no-write-fetch-head",
                "--no-tags",
                "--",
                "origin",
                refspec,
            ),
            {"cwd": workspace_root},
        ),
        (("jj", "-R", workspace_root, "git", "import"), {}),
        (("jj", "-R", workspace_root, "--quiet", "debug", "reindex"), {}),
    ]
    assert tracked == [("feature", "origin")]


def test_jj_get_pr_uses_stable_tracked_bookmark(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[tuple[str, ...], dict[str, object]]] = []
    tracked: list[tuple[str, str]] = []
    workspace_root = str(tmp_path / "example-workspace")

    monkeypatch.setenv("JJ_WORKSPACE_ROOT", workspace_root)
    monkeypatch.setattr(jj_module, "_normalize_repo", lambda _value: "owner/repo")
    monkeypatch.setattr(jj_module, "_shallow", lambda: False)
    monkeypatch.setattr(
        jj_module,
        "_gh_json",
        lambda *_args: {"baseRefName": "main"},
    )
    monkeypatch.setattr(
        jj_module,
        "_fetch_url",
        lambda _repo: "git@github.com:owner/repo.git",
    )
    monkeypatch.setattr(
        jj_module,
        "run",
        lambda argv, **kwargs: calls.append((argv, kwargs)),
    )
    monkeypatch.setattr(
        jj_module,
        "_track_remote_bookmark",
        lambda bookmark, remote: tracked.append((bookmark, remote)),
    )

    jj_module._resolve_pr("123", "owner/repo")

    assert calls == [
        (
            (
                "git",
                "fetch",
                "--prune",
                "--no-write-fetch-head",
                "--no-tags",
                "--",
                "git@github.com:owner/repo.git",
                "+refs/pull/123/head:refs/remotes/github-pr/pr/123",
            ),
            {"cwd": workspace_root},
        ),
        (("jj", "-R", workspace_root, "git", "import"), {}),
    ]
    assert tracked == [("pr/123", "github-pr")]


@pytest.mark.parametrize(
    ("listed", "should_track"), [("featurefeature", False), ("", True)]
)
def test_jj_get_tracks_remote_bookmark_idempotently(
    monkeypatch: pytest.MonkeyPatch,
    listed: str,
    should_track: bool,
) -> None:
    output_calls: list[tuple[str, ...]] = []
    run_calls: list[tuple[str, ...]] = []

    def fake_output(argv: tuple[str, ...]) -> str:
        output_calls.append(argv)
        return listed

    monkeypatch.setattr(jj_module, "output", fake_output)
    monkeypatch.setattr(jj_module, "run", run_calls.append)

    jj_module._track_remote_bookmark("feature", "origin")

    assert output_calls == [
        (
            "jj",
            "--ignore-working-copy",
            "bookmark",
            "list",
            "--tracked",
            "--remote",
            "exact:origin",
            "exact:feature",
            "--template",
            "name",
        )
    ]
    assert run_calls == (
        [("jj", "bookmark", "track", "feature@origin")] if should_track else []
    )


@pytest.mark.parametrize("target", ["@origin", "feature@"])
def test_jj_get_rejects_invalid_remote_bookmark_target(target: str) -> None:
    with pytest.raises(jj_module.DotfilesError, match="invalid BOOKMARK@REMOTE"):
        jj_module._resolve_branch(target, None, None)


def test_jj_git_fetch_import_uses_jj_workspace_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[tuple[str, ...], dict[str, object]]] = []
    workspace_root = str(tmp_path / "example-workspace")

    def fake_run(argv: tuple[str, ...], **kwargs: object) -> object:
        calls.append((argv, kwargs))
        return object()

    monkeypatch.setenv("JJ_WORKSPACE_ROOT", workspace_root)
    monkeypatch.setattr(sys, "argv", ["jj-git-fetch", "git", "fetch", "-b", "main"])
    monkeypatch.setattr(jj_module, "_shallow", lambda: True)

    def fake_git(*args: str, **_kwargs: object) -> str:
        if args == ("remote",):
            return "origin"
        if args[:2] == ("check-ref-format", "--branch"):
            return args[2]
        raise AssertionError(args)

    monkeypatch.setattr(jj_module, "_git", fake_git)
    monkeypatch.setattr(jj_module, "run", fake_run)
    boundaries = iter(["old-boundary", "new-boundary"])
    monkeypatch.setattr(jj_module, "_shallow_boundary", lambda: next(boundaries))

    jj_git_fetch_entrypoint()

    assert calls == [
        (
            (
                "git",
                "fetch",
                "--depth=1",
                "--prune",
                "--no-write-fetch-head",
                "--verbose",
                "--progress",
                "--no-tags",
                "--",
                "origin",
                "+refs/heads/main:refs/remotes/origin/main",
            ),
            {"cwd": workspace_root},
        ),
        (
            (
                "git",
                "fetch",
                "--deepen=1",
                "--no-write-fetch-head",
                "--verbose",
                "--progress",
                "--no-tags",
                "--",
                "origin",
                "+refs/heads/main:refs/remotes/origin/main",
            ),
            {"cwd": workspace_root},
        ),
        (("jj", "-R", workspace_root, "git", "import"), {}),
        (("jj", "-R", workspace_root, "--quiet", "debug", "reindex"), {}),
    ]


def test_jj_git_fetch_reports_command_errors_without_traceback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_run(*_args: object, **_kwargs: object) -> object:
        raise jj_module.DotfilesError("fetch failed")

    monkeypatch.setattr(sys, "argv", ["jj-git-fetch", "git", "fetch"])
    monkeypatch.setattr(jj_module, "_shallow", lambda: True)
    monkeypatch.setattr(
        jj_module,
        "_git",
        lambda *_args, **_kwargs: "origin",
    )
    monkeypatch.setattr(jj_module, "run", fake_run)

    with pytest.raises(SystemExit, match="fetch failed"):
        jj_git_fetch_entrypoint()


def test_jj_git_fetch_rejects_invalid_depth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JJ_GIT_FETCH_DEPTH", "all")
    monkeypatch.setattr(sys, "argv", ["jj-git-fetch", "git", "fetch"])
    monkeypatch.setattr(jj_module, "_shallow", lambda: True)
    monkeypatch.setattr(
        jj_module,
        "_git",
        lambda *_args, **_kwargs: "origin",
    )

    with pytest.raises(SystemExit, match="positive integer"):
        jj_git_fetch_entrypoint()


def test_jj_git_fetch_delegates_jj_string_expressions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    states: list[str] = []

    def fake_git(*args: str, **_kwargs: object) -> str:
        if args == ("remote",):
            return "origin"
        if args[:2] == ("check-ref-format", "--branch"):
            return ""
        raise AssertionError(args)

    monkeypatch.setattr(
        sys,
        "argv",
        ["jj-git-fetch", "git", "fetch", "--branch=exact:main"],
    )
    monkeypatch.setattr(jj_module, "_shallow", lambda: True)
    monkeypatch.setattr(jj_module, "_git", fake_git)
    monkeypatch.setattr(jj_module, "_shim_state", states.append)
    monkeypatch.setattr(
        jj_module,
        "run",
        lambda *_args, **_kwargs: pytest.fail("the shim should delegate"),
    )

    jj_git_fetch_entrypoint()

    assert states == ["delegate"]


def test_jj_redate_help_does_not_prompt(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["jj-redate", "--help"])

    jj_redate_entrypoint()

    assert capsys.readouterr().out.startswith("usage: jj-redate")


def test_jj_redate_gum_input_keeps_prompt_on_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[tuple[str, ...], dict[str, object]]] = []

    def fake_run(
        argv: tuple[str, ...],
        **kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, stdout="2026-07-10\n")

    monkeypatch.delenv("JJ_REDATE_NO_GUM", raising=False)
    monkeypatch.setattr(sys, "stdin", Tty())
    monkeypatch.setattr(sys, "stdout", Tty())
    monkeypatch.setattr(
        jj_module,
        "which",
        lambda name: Path("/opt/homebrew/bin/gum") if name == "gum" else None,
    )
    monkeypatch.setattr(jj_module.subprocess, "run", fake_run)

    assert jj_module._prompt("Date (YYYY-MM-DD): ", "2026-07-10") == "2026-07-10"
    assert calls == [
        (
            (
                "/opt/homebrew/bin/gum",
                "input",
                "--prompt",
                "Date (YYYY-MM-DD): ",
                "--value",
                "2026-07-10",
            ),
            {"check": False, "stdout": subprocess.PIPE, "text": True},
        )
    ]


def test_jj_redate_gum_confirm_is_interactive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[tuple[str, ...], dict[str, object]]] = []

    def fake_run(
        argv: tuple[str, ...],
        **kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.delenv("JJ_REDATE_NO_GUM", raising=False)
    monkeypatch.setattr(sys, "stdin", Tty())
    monkeypatch.setattr(sys, "stdout", Tty())
    monkeypatch.setattr(
        jj_module,
        "which",
        lambda name: Path("/opt/homebrew/bin/gum") if name == "gum" else None,
    )
    monkeypatch.setattr(jj_module.subprocess, "run", fake_run)

    assert jj_module._confirm_redate(["@-"], "2026-07-10T03:25:00+03:00")
    assert calls == [
        (
            (
                "/opt/homebrew/bin/gum",
                "confirm",
                (
                    "Set author and committer timestamp on @- to "
                    "2026-07-10T03:25:00+03:00?"
                ),
            ),
            {"check": False},
        )
    ]


def test_jj_redate_without_args_falls_back_to_working_copy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JJ_REDATE_NO_GUM", "1")
    monkeypatch.setattr(sys, "stdin", Tty())
    monkeypatch.setattr(sys, "stdout", Tty())

    assert jj_module._redate_revisions([]) == ["@"]


def test_jj_redate_uses_timezone_offset_for_selected_date(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    previous_tz = os.environ.get("TZ")
    values = iter(["2026-01-15", "12:00:00"])
    monkeypatch.setenv("TZ", "Europe/Sofia")
    time.tzset()
    monkeypatch.setattr(
        jj_module,
        "_prompt",
        lambda _label, _default: next(values),
    )

    try:
        assert jj_module._timestamp() == "2026-01-15T12:00:00+02:00"
    finally:
        if previous_tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous_tz
        time.tzset()


def test_jj_redate_rejects_empty_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jj_module, "_log", lambda *_args, **_kwargs: "")

    with pytest.raises(jj_module.DotfilesError, match="no revisions matched"):
        jj_module._selected_change_ids("none()")


def test_jj_redate_rejects_partial_divergent_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_log(revset: str, _template: str, reverse: bool = False) -> str:
        if revset == "selected":
            assert reverse
            return "change\n"
        assert revset == "change_id(change)"
        return "commit1\ncommit2\n"

    monkeypatch.setattr(jj_module, "_log", fake_log)

    with pytest.raises(jj_module.DotfilesError, match="part of divergent change"):
        jj_module._selected_change_ids("selected")


def test_jj_redate_rejects_divergent_descendant_timestamps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        jj_module,
        "_log",
        lambda *_args, **_kwargs: (
            "change\t2026-01-01T01:00:00.000+02:00\n"
            "change\t2026-01-01T02:00:00.000+02:00\n"
        ),
    )

    with pytest.raises(jj_module.DotfilesError, match="divergent descendant"):
        jj_module._descendant_timestamps("selected")


def test_jj_redate_rejects_partial_divergent_descendant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_log(revset: str, _template: str, reverse: bool = False) -> str:
        if revset.startswith("(selected)::"):
            assert reverse
            return "change\t2026-01-01T01:00:00.000+02:00\n"
        assert revset == "change_id(change)"
        return "commit1\ncommit2\n"

    monkeypatch.setattr(jj_module, "_log", fake_log)

    with pytest.raises(jj_module.DotfilesError, match="part of divergent change"):
        jj_module._descendant_timestamps("selected")


def test_jj_redate_without_args_opens_interactive_revision_picker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[tuple[str, ...], dict[str, object]]] = []

    def fake_log(revset: str, template: str, reverse: bool = False) -> str:
        assert not reverse
        assert "mutable() & remote_bookmarks().." in revset
        assert "change_id" in template
        return (
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t@\taaaaaaaa\tuser@example.com\t"
            "2026-01-02 03:04:05\t11111111\t\n"
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\to\tbbbbbbbb\tuser@example.com\t"
            "2026-01-02 03:00:00\t22222222\tadd sample feature\n"
        )

    def fake_run(
        argv: tuple[str, ...],
        **kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(
            argv,
            0,
            stdout=(
                "o bbbbbbbb user@example.com 2026-01-02 03:00:00 "
                "22222222  add sample feature\n"
            ),
        )

    monkeypatch.delenv("JJ_REDATE_NO_GUM", raising=False)
    monkeypatch.delenv("JJ_REDATE_REVSET", raising=False)
    monkeypatch.delenv("JJ_REDATE_LIMIT", raising=False)
    monkeypatch.setattr(sys, "stdin", Tty())
    monkeypatch.setattr(sys, "stdout", Tty())
    monkeypatch.setattr(
        jj_module,
        "which",
        lambda name: Path("/opt/homebrew/bin/gum") if name == "gum" else None,
    )
    monkeypatch.setattr(jj_module, "_log", fake_log)
    monkeypatch.setattr(jj_module.subprocess, "run", fake_run)

    assert jj_module._redate_revisions([]) == [
        "change_id(bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)"
    ]
    assert calls == [
        (
            (
                "/opt/homebrew/bin/gum",
                "choose",
                "--ordered",
                "--limit",
                "2",
                "--height",
                "5",
                "--header",
                "Select revisions to redate",
                (
                    "@ aaaaaaaa user@example.com 2026-01-02 03:04:05 "
                    "11111111  (no description set)"
                ),
                (
                    "o bbbbbbbb user@example.com 2026-01-02 03:00:00 "
                    "22222222  add sample feature"
                ),
            ),
            {"check": False, "stdout": subprocess.PIPE, "text": True},
        )
    ]
