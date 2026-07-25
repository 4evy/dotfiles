"""Linux system automation commands."""

from cyclopts import App

from workstation.host import apps

app = App(
    help="Configure the Linux system.",
    version_flags=[],
    result_action="return_none",
)
app.command(apps.app, name="apps")
