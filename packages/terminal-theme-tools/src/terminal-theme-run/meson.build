subdir('config')
subdir('launch')
subdir('support')
subdir('theme')

terminal_theme_run_sources = terminal_theme_run_config_sources
terminal_theme_run_sources += terminal_theme_run_launch_sources
terminal_theme_run_sources += terminal_theme_run_support_sources
terminal_theme_run_sources += terminal_theme_run_theme_sources

terminal_theme_run_lib = static_library(
    'terminal-theme-run-internal',
    terminal_theme_run_sources,
    c_args: project_c_args,
    extra_files: terminal_theme_run_data + terminal_theme_run_declarative_sources,
    include_directories: [include_directories('.'), project_config_include],
    dependencies: [
        glib_dep,
        gio_dep,
        gio_unix_dep,
        libvterm_dep,
        tomlc17_dep,
    ],
    install: false,
)

terminal_theme_run_dep = declare_dependency(
    include_directories: include_directories('.'),
    link_with: terminal_theme_run_lib,
    dependencies: [
        glib_dep,
        gio_dep,
        gio_unix_dep,
        libvterm_dep,
        tomlc17_dep,
    ],
)

terminal_theme_run = executable(
    'terminal-theme-run',
    [
        'main.c',
        project_config_header,
    ],
    c_args: project_c_args,
    dependencies: terminal_theme_run_dep,
    include_directories: project_config_include,
    install: true,
    link_args: project_link_args,
)
