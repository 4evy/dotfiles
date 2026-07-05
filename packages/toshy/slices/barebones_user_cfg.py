from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from xwaykeyz.config_api import C, bind, keymap

    cnfg: Any = None


_nd_filemanager_classes = {
    "caja",
    "com.system76.cosmicfiles",
    "dde-file-manager",
    "dolphin",
    "io.elementary.files",
    "krusader",
    "nautilus",
    "nemo",
    "org.gnome.nautilus",
    "org.kde.dolphin",
    "org.kde.krusader",
    "pcmanfm",
    "pcmanfm-qt",
    "peony-qt",
    "spacefm",
    "thunar",
}
_nd_terminal_classes = {
    "alacritty",
    "com.mitchellh.ghostty",
    "com.raggesilver.blackbox",
    "contour",
    "deepin-terminal",
    "foot",
    "footclient",
    "gnome-terminal",
    "gnome-terminal-server",
    "io.elementary.terminal",
    "kitty",
    "konsole",
    "org.gnome.console",
    "org.gnome.ptyxis",
    "org.gnome.terminal",
    "org.kde.konsole",
    "org.wezfurlong.wezterm",
    "ptyxis",
    "qterminal",
    "st",
    "terminator",
    "tilix",
    "wezterm",
    "xfce4-terminal",
    "xterm",
}
_nd_enter_renames_next = True
_nd_enter_last_filemanager_class = None


def _nd_wm_class(ctx):
    return (getattr(ctx, "wm_class", "") or "").casefold()


def _nd_is_filemanager(ctx):
    return _nd_wm_class(ctx) in _nd_filemanager_classes


def _nd_is_terminal(ctx):
    return _nd_wm_class(ctx) in _nd_terminal_classes


def _nd_enter_to_rename(ctx):
    global _nd_enter_renames_next, _nd_enter_last_filemanager_class

    wm_class = _nd_wm_class(ctx)
    if (
        _nd_enter_last_filemanager_class
        and _nd_enter_last_filemanager_class != wm_class
    ):
        _nd_enter_renames_next = True
        _nd_enter_last_filemanager_class = None

    if _nd_enter_renames_next:
        _nd_enter_renames_next = False
        _nd_enter_last_filemanager_class = wm_class
        return C("F2")

    _nd_enter_renames_next = True
    _nd_enter_last_filemanager_class = None
    return C("Enter")


def _nd_filemanager_passthrough(command):
    def _command(ctx):
        global _nd_enter_renames_next, _nd_enter_last_filemanager_class

        _nd_enter_renames_next = False
        _nd_enter_last_filemanager_class = _nd_wm_class(ctx)
        return command

    return _command


def _nd_filemanager_reset(command):
    def _command(_):
        global _nd_enter_renames_next, _nd_enter_last_filemanager_class

        _nd_enter_renames_next = True
        _nd_enter_last_filemanager_class = None
        return command

    return _command


keymap(
    "dotfiles macOS-style navigation",
    {
        C("C-Left"): C("Home"),
        C("C-Right"): C("End"),
        C("C-Up"): C("C-Home"),
        C("C-Down"): C("C-End"),
        C("Shift-C-Left"): C("Shift-Home"),
        C("Shift-C-Right"): C("Shift-End"),
        C("Shift-C-Up"): C("C-Shift-Home"),
        C("Shift-C-Down"): C("C-Shift-End"),
        C("Alt-Left"): [bind, C("C-Left")],
        C("Alt-Right"): [bind, C("C-Right")],
        C("Shift-Alt-Left"): [bind, C("C-Shift-Left")],
        C("Shift-Alt-Right"): [bind, C("C-Shift-Right")],
    },
    when=lambda ctx: cnfg.screen_has_focus and not _nd_is_terminal(ctx),
)

keymap(
    "dotfiles file manager Enter to rename",
    {
        C("Enter"): _nd_enter_to_rename,
        C("C-L"): _nd_filemanager_passthrough([bind, C("C-L")]),
        C("C-F"): _nd_filemanager_passthrough([bind, C("C-F")]),
        C("Esc"): _nd_filemanager_reset(C("Esc")),
    },
    when=lambda ctx: cnfg.screen_has_focus and _nd_is_filemanager(ctx),
)
