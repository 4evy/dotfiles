from pathlib import Path

from spectrum_build.programs.models import (
    FileOperation,
    FileOperationKind,
    execute_file_operations,
)


def test_declarative_file_operations_relocate_a_package_symlink(
    tmp_path: Path,
) -> None:
    local_prefix = tmp_path / "var/usrlocal"
    binary = tmp_path / "opt/1Password/1password-mcp"
    command = tmp_path / "usr/bin/1password-mcp"
    binary.parent.mkdir(parents=True)
    binary.write_text("binary")
    command.parent.mkdir(parents=True)

    execute_file_operations((
        FileOperation(
            FileOperationKind.ENSURE_DIRECTORY,
            local_prefix / "bin",
        ),
    ))
    (local_prefix / "bin/1password-mcp").symlink_to(binary)
    execute_file_operations((
        FileOperation(FileOperationKind.REQUIRE_FILE, binary),
        FileOperation(FileOperationKind.UNLINK, local_prefix / "bin/1password-mcp"),
        FileOperation(
            FileOperationKind.REMOVE_EMPTY_DIRECTORY,
            local_prefix / "bin",
        ),
        FileOperation(FileOperationKind.REMOVE_EMPTY_DIRECTORY, local_prefix),
        FileOperation(FileOperationKind.UNLINK, command),
        FileOperation(FileOperationKind.SYMLINK, command, binary),
    ))

    assert not local_prefix.exists()
    assert command.is_symlink()
    assert command.resolve() == binary
