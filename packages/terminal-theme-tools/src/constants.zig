pub const application = struct {
    pub const name = "terminal-theme-run";
    pub const version = "0.2.0";
    pub const description = "Run a command with terminal theme integration when a matching profile exists.";
};

pub const cli = struct {
    pub const help_option = "--help";
    pub const version_option = "--version";
    pub const option_prefix = "--";
    pub const separator = "--";
    pub const first_argument_index = 1;
};

pub const exit = struct {
    pub const success: u8 = 0;
    pub const failure: u8 = 1;
    pub const usage: u8 = 2;
    pub const cannot_execute: u8 = 126;
    pub const not_found: u8 = 127;
    pub const signal_offset: u8 = 128;
};

pub const environment = struct {
    pub const config = "TERMINAL_THEME_RUN_CONFIG";
    pub const home = "HOME";
    pub const path = "PATH";
    pub const temporary_directory = "TMPDIR";
    pub const xdg_cache_home = "XDG_CACHE_HOME";
    pub const xdg_config_home = "XDG_CONFIG_HOME";
};

pub const filesystem = struct {
    pub const config_directory = "terminal-theme-run";
    pub const config_file = "config.toml";
    pub const default_path = ".config/terminal-theme-run/config.toml";
    pub const default_search_path = "/usr/local/bin:/usr/bin:/bin";
    pub const default_cache_directory = ".cache";
    pub const default_temporary_directory = "/tmp";
    pub const max_file_bytes: usize = 1024 * 1024;
    pub const shebang_read_bytes: usize = 512;
    pub const mode_text_bytes: usize = 1024;
    pub const controlling_terminal = "/dev/tty";
};

pub const template = struct {
    pub const theme = "{theme}";
    pub const context = "{context}";
    pub const directory = "{directory}";
};

pub const protocol = struct {
    pub const terminal_environment = "TERM";
    pub const wildcard = "*";
    pub const background = "background";
    pub const color_scheme = "color-scheme";
    pub const background_query = "\x1b]11;?\x07";
    pub const color_scheme_query = "\x1b[?996n";
    pub const color_scheme_report_parameter: u16 = 997;
    pub const dark_report_value: u16 = 1;
    pub const light_report_value: u16 = 2;
    pub const osc_background = 11;
    pub const luminance_red = 0.299;
    pub const luminance_green = 0.587;
    pub const luminance_blue = 0.114;
    pub const color_channel_maximum = 255.0;
    pub const light_luminance_threshold = 0.5;
    pub const terminal_buffer_bytes: usize = 128;
    pub const milliseconds_per_second: i64 = 1000;
    pub const nanoseconds_per_millisecond: i64 = 1_000_000;
};

pub const text = struct {
    pub const whitespace = " \t\r\n";
    pub const horizontal_whitespace = " \t";
    pub const shebang = "#!";
    pub const assignment = " = ";
    pub const table_open = "={";
    pub const hex_digits = "0123456789ABCDEF";
};

pub const toml = struct {
    pub const field = struct {
        pub const runtime = "runtime";
        pub const interpreter = "interpreter";
        pub const runner = "runner";
        pub const integration = "integration";
        pub const name = "name";
        pub const aliases = "aliases";
        pub const programs = "programs";
        pub const skip_env = "skip_env";
        pub const default_args = "default_args";
        pub const env = "env";
        pub const env_unset = "env_unset";
        pub const strategy = "strategy";
        pub const display_name = "display_name";
        pub const dark_theme = "dark_theme";
        pub const light_theme = "light_theme";
        pub const arguments = "arguments";
        pub const context_table = "context_table";
        pub const context_field = "context_field";
        pub const context_value = "context_value";
        pub const context_path_flags = "context_path_flags";
        pub const context_path_prefixes = "context_path_prefixes";
        pub const context_argument_separator = "context_argument_separator";
        pub const context_directory_commands = "context_directory_commands";
        pub const default_config = "default_config";
        pub const assignment = "assignment";
        pub const config_flags = "config_flags";
        pub const config_output_flag = "config_output_flag";
        pub const temporary_prefix = "temporary_prefix";
        pub const temporary_location = "temporary_location";
        pub const cache_subdirectory = "cache_subdirectory";
        pub const quote = "quote";
        pub const validation = "validation";
        pub const shebang_commands = "shebang_commands";
        pub const shebang_arguments = "shebang_arguments";
        pub const theme_environment = "theme_environment";
        pub const theme_dark_aliases = "theme_dark_aliases";
        pub const theme_light_aliases = "theme_light_aliases";
        pub const theme_macos_commands = "theme_macos_commands";
        pub const theme_unix_commands = "theme_unix_commands";
        pub const theme_terminal_program_environment = "theme_terminal_program_environment";
        pub const theme_terminal_queries = "theme_terminal_queries";
        pub const theme_macos_fallback = "theme_macos_fallback";
        pub const theme_unix_fallback = "theme_unix_fallback";
        pub const theme_probe_timeout_ms = "theme_probe_timeout_ms";
        pub const helper_timeout_ms = "helper_timeout_ms";
        pub const helper_output_limit_bytes = "helper_output_limit_bytes";
    };
    pub const root_fields = &.{ field.runtime, field.interpreter, field.runner, field.integration };
    pub const runtime_fields = &.{ field.theme_environment, field.theme_dark_aliases, field.theme_light_aliases, field.theme_macos_commands, field.theme_unix_commands, field.theme_terminal_program_environment, field.theme_terminal_queries, field.theme_macos_fallback, field.theme_unix_fallback, field.theme_probe_timeout_ms, field.helper_timeout_ms, field.helper_output_limit_bytes };
    pub const interpreter_fields = &.{ field.name, field.shebang_commands, field.shebang_arguments, field.programs };
    pub const runner_fields = &.{ field.name, field.aliases, field.programs, field.skip_env, field.default_args, field.env, field.env_unset, field.integration, field.interpreter };
    pub const integration_fields = &.{ field.name, field.strategy, field.display_name, field.dark_theme, field.light_theme, field.arguments, field.context_table, field.context_field, field.context_value, field.context_path_flags, field.context_path_prefixes, field.context_argument_separator, field.context_directory_commands, field.default_config, field.assignment, field.config_flags, field.config_output_flag, field.temporary_prefix, field.temporary_location, field.cache_subdirectory, field.quote, field.validation };
    pub const arguments_strategy = "arguments";
    pub const config_strategy = "config";
    pub const system_location = "system";
    pub const cache_location = "cache";
    pub const toml_validation = "toml";
    pub const dark = "dark";
    pub const light = "light";
    pub const temporary_suffix = "XXXXXX";
    pub const runtime_limit_maximum: u64 = 60_000;
};
