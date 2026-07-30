# Terminal theme tools

Small C utilities that adapt terminal applications to the active light or dark
theme.

## Build

Keep generated configurations together under `build/`:

```sh
meson setup build/debug
meson compile -C build/debug
meson test -C build/debug
```

For a sanitizer configuration:

```sh
meson setup build/sanitize -Db_lundef=false -Db_sanitize=address,undefined
meson compile -C build/sanitize
meson test -C build/sanitize
```

Project options can be inspected or changed with:

```sh
meson configure build/debug
meson configure build/debug -Dstrict=false
```
