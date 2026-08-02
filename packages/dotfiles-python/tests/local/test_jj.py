from pathlib import Path
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from cyclopts import App

from workstation.local.jj import (
    get as get_module,
    repository as repository_module,
)


def _invoke(
    cli: App, arguments: list[str], capsys: pytest.CaptureFixture[str]
) -> tuple[int, str]:
    try:
        cli(arguments)
    except SystemExit as error:
        exit_code = error.code if isinstance(error.code, int) else 1
    else:
        exit_code = 0
    captured = capsys.readouterr()
    return exit_code, captured.out + captured.err


def test_jj_get_accepts_pr_url_query(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    resolved: list[tuple[str, str | None]] = []
    monkeypatch.setattr(get_module, "_git", lambda *_args, **_kwargs: ".git")
    monkeypatch.setattr(
        get_module,
        "_resolve_pr",
        lambda number, repo: resolved.append((number, repo)),
    )

    exit_code, output = _invoke(
        get_module.app,
        ["https://downloads.com/owner/repo/pull/123?notification_referrer=1"],
        capsys,
    )

    assert exit_code == 0, output
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
    monkeypatch.setattr(repository_module, "output", fake_output)

    assert not repository_module.is_shallow()
    assert calls == [
        (
            ("git", "rev-parse", "--is-shallow-repository"),
            False,
            workspace_root,
        )
    ]


def test_jj_get_shallow_branch_delegates_mutation_to_jj(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[str, ...]] = []
    workspace_root = str(tmp_path / "example-workspace")

    monkeypatch.setenv("JJ_WORKSPACE_ROOT", workspace_root)
    monkeypatch.setattr(get_module, "_shallow", lambda: True)
    monkeypatch.setattr(
        get_module,
        "_git",
        lambda *args, **_kwargs: (
            "git@example.com:owner/repo.git"
            if args == ("remote", "get-url", "origin")
            else pytest.fail(f"unexpected git arguments: {args}")
        ),
    )
    monkeypatch.setattr(get_module, "run", calls.append)

    get_module._resolve_branch("feature", "origin", "main")

    assert calls == [
        (
            "jj",
            "-R",
            workspace_root,
            "git",
            "ref",
            "fetch",
            "--remote",
            "origin",
            "--bookmark",
            "feature",
            "--replace",
            "--shallow-exclude",
            "refs/heads/main",
            "refs/heads/feature",
        )
    ]


def test_jj_get_pr_delegates_mutation_to_jj(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[str, ...]] = []
    workspace_root = str(tmp_path / "example-workspace")

    monkeypatch.setenv("JJ_WORKSPACE_ROOT", workspace_root)
    monkeypatch.setattr(get_module, "_normalize_repo", lambda _value: "owner/repo")
    monkeypatch.setattr(get_module, "_shallow", lambda: True)
    monkeypatch.setattr(
        get_module,
        "_gh_json",
        lambda model, *_args: model.model_validate({
            "baseRefName": "main",
            "headRefName": "contributor/push-changeid",
        }),
    )
    monkeypatch.setattr(
        get_module,
        "_fetch_url",
        lambda _repo: "git@downloads.com:owner/repo.git",
    )
    monkeypatch.setattr(
        get_module,
        "_git",
        lambda *args, **_kwargs: (
            ""
            if args == ("remote",)
            else pytest.fail(f"unexpected git arguments: {args}")
        ),
    )
    monkeypatch.setattr(get_module, "run", calls.append)

    get_module._resolve_pr("123", "owner/repo")

    assert calls == [
        (
            "jj",
            "-R",
            workspace_root,
            "git",
            "remote",
            "add",
            "github-pr",
            "git@downloads.com:owner/repo.git",
        ),
        (
            "jj",
            "-R",
            workspace_root,
            "git",
            "ref",
            "fetch",
            "--remote",
            "github-pr",
            "--bookmark",
            "contributor/push-changeid",
            "--replace",
            "--shallow-exclude",
            "refs/heads/main",
            "refs/pull/123/head",
        ),
    ]


@pytest.mark.parametrize(
    ("remotes", "current_url", "expected"),
    [
        (
            "",
            "",
            (
                "jj",
                "git",
                "remote",
                "add",
                "github-pr",
                "git@example.com:new/repo.git",
            ),
        ),
        ("github-pr", "git@example.com:new/repo.git", None),
        (
            "github-pr",
            "git@example.com:old/repo.git",
            (
                "jj",
                "git",
                "remote",
                "set-url",
                "github-pr",
                "git@example.com:new/repo.git",
            ),
        ),
    ],
)
def test_configure_remote(
    monkeypatch: pytest.MonkeyPatch,
    remotes: str,
    current_url: str,
    expected: tuple[str, ...] | None,
) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_git(*args: str, **_kwargs: object) -> str:
        if args == ("remote",):
            return remotes
        if args == ("remote", "get-url", "github-pr"):
            return current_url
        return pytest.fail(f"unexpected git arguments: {args}")

    monkeypatch.setattr(get_module, "_git", fake_git)
    monkeypatch.setattr(get_module, "_jj", lambda: ("jj",))
    monkeypatch.setattr(get_module, "run", calls.append)

    get_module._configure_remote("github-pr", "git@example.com:new/repo.git")

    assert calls == ([expected] if expected else [])
