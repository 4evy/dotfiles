terminal_theme_run_data = files(
    'terminal-theme-run/runners.toml',
    'terminal-theme-run/integrations.toml',
    'terminal-theme-run/runtime-defaults.toml',
)

install_data(
    terminal_theme_run_data,
    install_dir: get_option('datadir') / meson.project_name() / 'terminal-theme-run',
)
