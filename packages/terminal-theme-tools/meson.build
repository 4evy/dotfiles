project(
    'terminal-theme-tools',
    'c',
    version: '0.1.0',
    meson_version: '>=1.4.0',
    default_options: [
        'b_asneeded=true',
        'b_ndebug=if-release',
        'b_pie=true',
        'c_std=c23',
        'warning_level=3',
        'werror=true',
    ],
)

cc = meson.get_compiler('c')

if not cc.compiles(
    '''
        #if !defined(__STDC_VERSION__) || __STDC_VERSION__ < 202311L
        #error "ISO C23 language mode is required"
        #endif
        int main(void) {
            return 0;
        }
    ''',
    name: 'ISO C23 language mode',
)
    error('terminal-theme-tools requires an ISO C23 compiler')
endif

subdir('meson')

glib_dep = dependency('glib-2.0', version: '>=2.76', include_type: 'system')
gio_dep = dependency('gio-2.0', version: '>=2.76', include_type: 'system')
gio_unix_dep = dependency(
    'gio-unix-2.0',
    version: '>=2.76',
    include_type: 'system',
)
libvterm_dep = dependency('vterm', version: '>=0.3', include_type: 'system')
tomlc17_dep = dependency(
    'libtomlc17',
    fallback: ['tomlc17', 'tomlc17_dep'],
    include_type: 'system',
)

project_configuration = configuration_data()
project_configuration.set_quoted('TTR_VERSION', meson.project_version())
project_configuration.set_quoted(
    'TTR_DATA_DIR',
    get_option('prefix') / get_option('datadir') / meson.project_name() / 'terminal-theme-run',
)
project_configuration.set10(
    'HAVE_CFMAKERAW',
    cc.has_function(
        'cfmakeraw',
        args: project_c_args,
        prefix: '#include <termios.h>',
    ),
)
project_config_header = configure_file(
    output: 'config.h',
    configuration: project_configuration,
)
project_config_include = include_directories('.')

subdir('data')
subdir('src')
subdir('tests')
