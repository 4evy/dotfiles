foreach module : [
    'manifest',
    'runner',
    'terminal',
    'theme',
    'toml-schema',
    'trust',
]
    test_environment = []
    extra_test_files = []
    if module == 'theme'
        integration_fixture = meson.current_source_dir() / 'fixtures/integrations.toml'
        test_environment += 'TERMINAL_THEME_RUN_CONFIG=' + integration_fixture
        extra_test_files += files('fixtures/integrations.toml')
    endif

    module_tests = executable(
        'terminal-theme-run-test-' + module,
        [
            'test-' + module + '.c',
            'test-support.c',
        ],
        c_args: strict_c_args,
        dependencies: terminal_theme_run_dep,
        extra_files: extra_test_files,
        link_args: strict_link_args,
    )

    test(
        'terminal-theme-run / ' + module,
        module_tests,
        env: test_environment,
        protocol: 'tap',
        suite: 'terminal-theme-run',
    )
endforeach

test(
    'terminal-theme-run / help',
    terminal_theme_run,
    args: ['--help'],
    suite: 'terminal-theme-run',
)
test(
    'terminal-theme-run / version',
    terminal_theme_run,
    args: ['--version'],
    suite: 'terminal-theme-run',
)
