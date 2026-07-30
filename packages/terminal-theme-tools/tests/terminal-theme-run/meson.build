default_data_environment = [
    'TERMINAL_THEME_RUN_DATA_DIR=' + meson.project_source_root() / 'data/terminal-theme-run',
]

terminal_theme_run_test_include = include_directories('.')

foreach test_definition : [
    ['manifest', 'config/test-manifest.c'],
    ['toml-schema', 'config/test-toml-schema.c'],
    ['values', 'config/test-values.c'],
    ['runner', 'launch/test-runner.c'],
    ['io', 'support/test-io.c'],
    ['context', 'theme/test-context.c'],
    ['terminal', 'theme/test-terminal.c'],
    ['theme', 'theme/test-theme.c'],
]
    module = test_definition[0]
    test_source = test_definition[1]
    test_environment = default_data_environment
    extra_test_files = []
    if module == 'theme'
        integration_fixture = meson.current_source_dir() / 'fixtures/integrations.toml'
        test_environment += 'TERMINAL_THEME_RUN_CONFIG=' + integration_fixture
        extra_test_files += files('fixtures/integrations.toml')
    endif

    module_tests = executable(
        'terminal-theme-run-test-' + module,
        [
            test_source,
            'support/test-support.c',
        ],
        c_args: project_c_args,
        dependencies: terminal_theme_run_dep,
        extra_files: extra_test_files,
        include_directories: terminal_theme_run_test_include,
        link_args: project_link_args,
    )

    test(
        'terminal-theme-run / ' + module,
        module_tests,
        env: test_environment,
        protocol: 'tap',
        suite: 'terminal-theme-run',
    )
endforeach
