# system-clipboard.yazi

Copy selected files, or the hovered file when nothing is selected, to the system clipboard.

Supported backends:

- macOS file clipboard: AppKit through the system `osascript`
- Linux Wayland: `wl-copy`
- Linux X11/XWayland fallback: `xclip`

Default behavior on Wayland is desktop-aware:

- GNOME-like sessions use `x-special/gnome-copied-files`, which Nautilus/GNOME Files expects for file copy and cut operations.
- KDE/Plasma, LXQt, and unknown window-manager sessions use `text/uri-list`, the standard URI-list format understood by many file managers.

`wl-copy` and `xclip` advertise one file-list format per clipboard owner, so the plugin chooses the best format for the current desktop. On macOS, the default mode publishes native `public.file-url` pasteboard items so Finder and other GUI apps receive actual files. The optional `--paths` and `--uris` modes use `pbcopy` when path text is desired instead.

## Keymap

```toml
{ on = "Y", run = "plugin system-clipboard", desc = "Copy selected files to system clipboard" }
```

Optional modes:

```toml
{ on = ["c", "p"], run = "plugin system-clipboard --paths", desc = "Copy paths as text" }
{ on = ["c", "u"], run = "plugin system-clipboard --uris", desc = "Copy file URIs as text" }
{ on = ["c", "g"], run = "plugin system-clipboard --gnome", desc = "Copy files for GNOME/Nautilus" }
{ on = ["c", "k"], run = "plugin system-clipboard --kde", desc = "Copy files as URI list" }
```
