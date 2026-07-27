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


def test_jj_get_help_does_not_require_a_repository(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        get_module,
        "_git",
        lambda *_args, **_kwargs: pytest.fail("help must not inspect the repository"),
    )
    exit_code, output = _invoke(get_module.app, ["--help"], capsys)

    assert exit_code == 0
    assert "Usage:" in output


@pytest.mark.parametrize(
    "arguments",
    [
        ["123", "owner/repo", "ignored"],
        ["https://github.com/owner/repo/pull/123", "ignored"],
    ],
)
def test_jj_get_rejects_extra_pr_arguments(
    arguments: list[str],
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code, output = _invoke(get_module.app, arguments, capsys)

    assert exit_code == 1
    assert "Invalid value" in output


def test_jj_get_rejects_base_after_remote_in_target(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code, output = _invoke(
        get_module.app,
        ["feature@upstream", "main", "ignored"],
        capsys,
    )

    assert exit_code == 1
    assert "BOOKMARK@REMOTE" in output


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
        ["https://github.com/owner/repo/pull/123?notification_referrer=1"],
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
            "fetch-ref",
            "--source",
            "origin",
            "refs/heads/feature",
            "--remote",
            "origin",
            "--bookmark",
            "feature",
            "--track",
            "--shallow-exclude",
            "refs/heads/main",
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
        lambda _repo: "git@github.com:owner/repo.git",
    )
    monkeypatch.setattr(get_module, "run", calls.append)

    get_module._resolve_pr("123", "owner/repo")

    assert calls == [
        (
            "jj",
            "-R",
            workspace_root,
            "git",
            "fetch-ref",
            "--source",
            "git@github.com:owner/repo.git",
            "refs/pull/123/head",
            "--remote",
            "github-pr",
            "--bookmark",
            "contributor/push-changeid",
            "--track",
            "--shallow-exclude",
            "refs/heads/main",
        )
    ]


@pytest.mark.parametrize("target", ["@origin", "feature@"])
def test_jj_get_rejects_invalid_remote_bookmark_target(target: str) -> None:
    with pytest.raises(get_module.DotfilesError, match="invalid BOOKMARK@REMOTE"):
        get_module._resolve_branch(target, None, None)
