"""Host application command group.

The command tree stays stable here while each integration owns its domain logic.
"""

from cyclopts import App

from workstation.host.rustdesk import rustdesk_system, rustdesk_tailscale
from workstation.host.tailscale import tailscale_bluefin, tailscale_system

__all__ = ["app"]

app = App(
    help="Configure host networking and remote desktop.",
    version_flags=[],
    result_action="return_none",
)
app.command(rustdesk_system, name="rustdesk-system", show=False)
app.command(rustdesk_tailscale, name="rustdesk-tailscale")
app.command(tailscale_system, name="tailscale-system", show=False)
app.command(tailscale_bluefin, name="tailscale-bluefin")
