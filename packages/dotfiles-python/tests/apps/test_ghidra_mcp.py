import os
import py_compile
import stat
from pathlib import Path

from workstation.apps.ghidra_mcp import _render_wrappers


def test_rendered_ghidra_wrappers_are_executable_python(tmp_path: Path) -> None:
    scripts = Path(__file__).resolve().parents[2]
    support = scripts / "assets/apps/ghidra-mcp"
    stage = tmp_path / "stage"

    _render_wrappers(stage, tmp_path / "install", tmp_path / "ghidra", support)

    wrappers = sorted((stage / "bin").iterdir())
    assert [path.name for path in wrappers] == [
        "ghidra-mcp-bridge",
        "ghidra-mcp-headless",
        "ghidra-mcp-httpd",
        "ghidra-mcp-serve",
    ]
    for wrapper in wrappers:
        assert stat.S_IMODE(wrapper.stat().st_mode) == 0o755
        py_compile.compile(os.fspath(wrapper), doraise=True)
