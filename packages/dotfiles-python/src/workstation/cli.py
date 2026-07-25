from cyclopts import App

from workstation import __version__
from workstation.apps import app as apps_app
from workstation.automation import machine_entrypoint
from workstation.chezmoi import app as chezmoi_app
from workstation.console import error_console
from workstation.errors import DotfilesError
from workstation.host import app as host_app
from workstation.local import hyper_window_tiling_build
from workstation.macos import app as macos_app
from workstation.manifest_commands import app as manifests_app

app = App(
    help="Repository, workstation, and host automation.",
    version=f"dotfiles-scripts version {__version__}",
    result_action="return_none",
)
app.command(apps_app, name="apps")
app.command(chezmoi_app, name="chezmoi")
app.command(hyper_window_tiling_build.app, name="hyper-window-tiling")
app.command(host_app, name="host")
app.command(manifests_app, name="manifests")
app.command(macos_app, name="macos")
app.command(machine_entrypoint, name="_ansible-v1", show=False)


def entrypoint() -> None:
    try:
        app()
    except DotfilesError as error:
        error_console.print(f"[bold red]error:[/bold red] {error}")
        raise SystemExit(1) from error


if __name__ == "__main__":
    entrypoint()
