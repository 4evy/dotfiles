#!/usr/bin/env python3.14
"""Start Solaar with its window hidden and without a tray icon."""

import sys

# Solaar's interpreter supplies this module on the deployed host.
from solaar import gtk  # ty: ignore[unresolved-import]

original_window_init = gtk.ui.window.init


def init_hidden_window(_show_window: bool, hide_on_close: bool) -> None:
    original_window_init(False, hide_on_close)


gtk.ui.window.init = init_hidden_window
sys.argv = ["solaar", "--window=only", *sys.argv[1:]]
gtk.main()
