"""macOS workstation configuration commands."""

from cyclopts import App

from workstation.macos import system

app = App(
    help="Configure macOS system integration.",
    version_flags=[],
    result_action="return_none",
)
app.command(system.configure_karabiner_vhid, name="karabiner-vhid")
app.command(system.configure_kanata, name="kanata")
