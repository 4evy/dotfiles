# First-party compiler and linker policy shared by production and test targets.
project_c_args = ['-D_POSIX_C_SOURCE=200809L']
project_link_args = []

if host_machine.system() == 'darwin'
    # Keep POSIX as the baseline while exposing supported Darwin extensions
    # such as cfmakeraw(3) from the macOS SDK.
    project_c_args += '-D_DARWIN_C_SOURCE'
endif

if get_option('strict')
    strict_warning_args = [
        '-Walloca',
        '-Warray-bounds=2',
        '-Wbad-function-cast',
        '-Wcast-align',
        '-Wcast-align=strict',
        '-Wcast-function-type',
        '-Wcast-qual',
        '-Wcomma',
        '-Wconversion',
        '-Wdate-time',
        '-Wdouble-promotion',
        '-Wduplicated-branches',
        '-Wduplicated-cond',
        '-Wenum-conversion',
        '-Wfloat-equal',
        '-Wformat=2',
        '-Wformat-overflow=2',
        '-Wformat-signedness',
        '-Wformat-truncation=2',
        '-Wimplicit-fallthrough',
        '-Wimplicit-fallthrough=5',
        '-Wlogical-op',
        '-Wmissing-declarations',
        '-Wmissing-format-attribute',
        '-Wmissing-prototypes',
        '-Wnull-dereference',
        '-Wpointer-arith',
        '-Wredundant-decls',
        '-Wshadow',
        '-Wshift-overflow=2',
        '-Wsign-conversion',
        '-Wstrict-prototypes',
        '-Wstringop-overflow=4',
        '-Wstringop-truncation',
        '-Wsuggest-attribute=cold',
        '-Wsuggest-attribute=const',
        '-Wsuggest-attribute=format',
        '-Wsuggest-attribute=malloc',
        '-Wsuggest-attribute=noreturn',
        '-Wsuggest-attribute=pure',
        '-Wswitch-enum',
        '-Wundef',
        '-Wunreachable-code',
        '-Wvla',
        '-Wwrite-strings',
    ]

    if cc.get_id() == 'clang'
        strict_warning_args += [
            '-Weverything',
            # Exclude only C++/pre-C23 compatibility, ABI-padding, and diagnostics
            # caused by GLib's cleanup macros. Clang's experimental unsafe-buffer
            # migration warning cannot model conventional null-terminated C vectors;
            # ASan, UBSan, Clang-Tidy, and both static analyzers cover those accesses.
            '-Wno-c++98-compat',
            '-Wno-c++98-compat-pedantic',
            '-Wno-c++-keyword',
            '-Wno-covered-switch-default',
            '-Wno-declaration-after-statement',
            '-Wno-disabled-macro-expansion',
            '-Wno-implicit-int-enum-cast',
            '-Wno-implicit-void-ptr-cast',
            '-Wno-jump-misses-init',
            '-Wno-padded',
            '-Wno-poison-system-directories',
            '-Wno-pre-c11-compat',
            '-Wno-pre-c23-compat',
            '-Wno-c2y-extensions',
            '-Wno-unsafe-buffer-usage',
            '-Wno-used-but-marked-unused',
        ]
    elif cc.get_id() == 'gcc'
        strict_warning_args += [
            '-Warith-conversion',
            '-Walloc-zero',
            '-Wattribute-alias=2',
            '-Wbidi-chars=any',
            '-Wformat-diag',
            '-Wjump-misses-init',
            '-Wmissing-include-dirs',
            '-Wmultistatement-macros',
            '-Wnormalized=nfc',
            '-Wno-suggest-attribute=const',
            '-Wno-suggest-attribute=pure',
            '-Wpacked-not-aligned',
            '-Wrestrict',
            '-Wstring-compare',
            '-Wtrampolines',
            '-Wuse-after-free=3',
            '-Wzero-length-bounds',
        ]
    endif

    project_c_args += cc.get_supported_arguments(strict_warning_args)
endif

if get_option('hardening')
    project_c_args += cc.get_supported_arguments(
        [
            '-fno-common',
            '-fno-strict-overflow',
            '-fcf-protection=full',
            '-fstack-clash-protection',
            '-fstack-protector-strong',
            '-ftrivial-auto-var-init=pattern',
            '-fzero-call-used-regs=used-gpr',
            '-mbranch-protection=standard',
        ],
    )

    if get_option('optimization') not in ['0', 'g']
        project_c_args += cc.get_supported_arguments(['-D_FORTIFY_SOURCE=3'])
    endif

    foreach argument : [
        '-Wl,--as-needed',
        '-Wl,--error-execstack',
        '-Wl,--fatal-warnings',
        '-Wl,--no-undefined',
        '-Wl,--warn-common',
        '-Wl,--warn-execstack',
        '-Wl,-fatal_warnings',
        '-Wl,-z,defs',
        '-Wl,-z,noexecstack',
        '-Wl,-z,now',
        '-Wl,-z,relro',
        '-Wl,-z,separate-code',
    ]
        # Sanitizer runtimes can emit linker warnings from their own assembly
        # objects on newer binutils. Keep every hardening flag, but do not turn
        # third-party runtime warnings into link failures for sanitizer builds.
        if get_option('b_sanitize') != 'none' and argument in [
            '-Wl,--fatal-warnings',
            '-Wl,-fatal_warnings',
        ]
            continue
        endif
        if cc.has_link_argument(argument)
            project_link_args += argument
        endif
    endforeach
endif

if get_option('gcc_analyzer')
    if cc.get_id() != 'gcc'
        error('gcc_analyzer requires GCC')
    endif
    project_c_args += cc.get_supported_arguments(
        [
            '-fanalyzer',
            '-fanalyzer-call-summaries',
            '-fanalyzer-transitivity',
        ],
    )
endif
