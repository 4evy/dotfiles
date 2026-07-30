"""Application configuration commands."""

from cyclopts import App

from workstation.apps import helium

app = App(
    help="Install and configure workstation applications.",
    version_flags=[],
    result_action="return_none",
)
app.command(helium.configure_helium_linux, name="configure-helium-linux")
app.command(helium.configure_helium_macos, name="configure-helium-macos")
