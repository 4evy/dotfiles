# shellcheck disable=SC2154
#              ⢀⣠⢤⠤⡤⢤⣀
#            ⣠⠾⡙⢌⠢⡑⢌⠢⡙⢝⢦⡀
#           ⣰⠣⡑⠈ ⠑⢌⠢⠑⠈⠢⡑⢷⡀                 ⡖⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⡆                     ⢀⡠⠤⣶⡆
#          ⣰⠣⡑⠄⢰⡆⠈⠢⡁ ⣶ ⢌⠢⣱⡀           ⢀⡴⠒⠒⠒⡇  ⣠⡴⢾⢲⢤⡀  ⡗⠒⠒⠲⣄                 ⢸⢣⠾⢼
#         ⢀⡧⡑⢌⠢ ⢀⣀⠥⢌⣀ ⢀⠢⡑⢌⣇     ⢰⣳⠦⠤⠤⠴⠋    ⡇ ⢠⠯⡷⡛⠷⣏⢧  ⡇   ⠈⠳⠤⠤⠤⢶⣳           ⣿⢿⡾⠛⠒⣲⣤
#         ⢸⡑⢌⠢⡑⠘⠯⣀ ⢀⡨⠟⠢⡑⢌⠢⣹           ⣠⠞⠉⠉⠉⡇ ⠸⣏⣧⡐⣨⡏⡿  ⡏⠉⠉⠙⢦⡀          ⢠⠴⠒⠒⠒⠢⠴⠁ ⢠⠋⠁
#         ⢸⢌⣾⡑⣀  ⢨⣷⣯  ⢀⣈⢺⣕⢼     ⠸⠽⠓⠒⠒⠚⠁⢀⣀⣀⣀⡇  ⠻⢧⣹⣱⠽⠃  ⣇⣀⣀⣀ ⠙⠒⠒⠒⠻⠽    ⢰⠃⡄       ⠸⣄
#         ⢸⠮⡹⢾⠓⠒⠒⢻⣷⣿⠓⠒⠒⢳⡻⣌⢾     ⢀⣄⡀  ⢀⡴⠋   ⣇⣀⣀⣀⣀⣈⣀⣀⣀⣀⣀⡇  ⠈⠳⣄   ⣀⣄    ⡏⢸⠁        ⠈⠉⡇
#        ⣰⠻⡗⣏⢺    ⠉⠁   ⢸⢌⡧⡟⢷⡀   ⠘⠚⠉⠉⠉⠉                     ⠈⠉⠉⠉⠙⠚    ⡇⢻           ⡇
#       ⣴⠣⣑⣿⡧⡹⡄        ⣼⠢⣷⣏⡢⡱⡄                                       ⢹⣻⣆         ⢀⡇
#      ⠚⠚⠉⠁ ⢳⣌⠳⡄      ⣴⠣⣱⠃ ⠉⠙⠚⠂                                       ⢿⡝⠂       ⢀⡞
#        ⣀⡤⠤⠤⠵⢵⢼⣂⡀  ⣀⣾⢦⠵⠥⠤⠤⣄⡀                                          ⠙⠲⠤⠤⠤⠤⠤⠤⠔⠋
#      ⢠⡋ ⢰ ⢰  ⡟⠻⢽⠦⢵⠽⠚⡇ ⢰ ⢰ ⠈⣣
#       ⠙⠢⠼⣄⣘⣀⡤⠧⠖⠋ ⠈⠓⠦⠧⣄⣘⣀⡼⠤⠚⠁

# B1 / Codex wrapper
# Reset focus reporting around the themed Codex session and optional debuggers

cx() {
	local cmd_status

	_dotfiles_disable_terminal_focus_reporting
	theme-run codex "$@"
	cmd_status=$?
	_dotfiles_disable_terminal_focus_reporting

	return "$cmd_status"
}

_dotfiles_ghidra_mcp_ready() {
	local url="${GHIDRA_MCP_URL:-http://${GHIDRA_MCP_CONNECT_HOST:-127.0.0.1}:${GHIDRA_MCP_PORT:-8089}}"
	local -a auth
	auth=()
	if [[ -n "${GHIDRA_MCP_AUTH_TOKEN:-}" ]]; then
		auth=(-H "Authorization: Bearer $GHIDRA_MCP_AUTH_TOKEN")
	fi
	curl --fail --silent --max-time 2 --noproxy '*' "${auth[@]}" \
		"${url%/}/check_connection" >/dev/null 2>&1
}

_dotfiles_start_ghidra_mcp_for_cxg() {
	local timeout="${GHIDRA_MCP_STARTUP_TIMEOUT:-120}"
	local started_at=$SECONDS
	if ! [[ "$timeout" =~ ^[1-9][0-9]*$ ]]; then
		printf '%s\n' 'GHIDRA_MCP_STARTUP_TIMEOUT must be a positive integer' >&2
		return 2
	fi
	if _dotfiles_ghidra_mcp_ready; then
		return 0
	fi

	# The user service owns the backend independently of Codex sessions
	if [[ $(uname -s) == Linux ]]; then
		systemctl --user start ghidra-mcp.service || return
	elif [[ $(uname -s) == Darwin ]]; then
		local domain="gui/$(id -u)"
		local label
		local found=0
		for label in org.ai-tools.ghidra-mcp org.nix-community.home.ghidra-mcp org.nixos.ghidra-mcp; do
			if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
				/bin/launchctl kickstart "$domain/$label" || return
				found=1
				break
			fi
		done
		if ((found == 0)); then
			printf '%s\n' 'Ghidra MCP user service is not installed; apply the AI Hjem configuration' >&2
			return 1
		fi
	fi
	until _dotfiles_ghidra_mcp_ready; do
		if ((SECONDS - started_at >= timeout)); then
			printf '%s\n' "Ghidra MCP backend did not become ready within ${timeout}s; check the ghidra-mcp user service" >&2
			return 1
		fi
		sleep 1
	done
}

cxg() (
	local -a codex_args
	local cmd_status
	case "${1:-}" in
		-h | --help | -V | --version | help)
			cx "$@"
			exit "$?"
			;;
	esac

	_dotfiles_start_ghidra_mcp_for_cxg || exit "$?"
	codex_args=(-c mcp_servers.ghidra.enabled=true)
	if command -v lldb-mcp-launcher >/dev/null 2>&1; then
		codex_args+=(-c mcp_servers.lldb.enabled=true)
	fi
	_dotfiles_disable_terminal_focus_reporting
	theme-run codex "${codex_args[@]}" "$@"
	cmd_status=$?
	_dotfiles_disable_terminal_focus_reporting
	exit "$cmd_status"
)
