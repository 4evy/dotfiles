"""macOS workstation configuration commands."""

from cyclopts import App

from workstation.macos import ghostty, kanata

app = App(
    help="Configure macOS system integration.",
    version_flags=[],
    result_action="return_none",
)
app.command(kanata.configure_kanata, name="kanata")
app.command(ghostty.sign_ghostty, name="sign-ghostty")
