import { TERMINAL_KEYS } from "../jobs/terminal";
import { JOB_ACTIONS } from "../jobs/types";

export const TOPICS = {
  start: {
    tools: [],
    text: `Load connect to save a connection, then run for shell commands.
Linux and macOS jobs require omp-helper; load helper if it is missing.
Load other topics as needed. Loopback arguments and saved connections appear below.`,
  },
  connect: {
    tools: ["remote_connect"],
    text: `Pass target as an OMP host name, OpenSSH alias or user@host. username, port
and keyPath override SSH configuration. cwd defaults to the remote home;
relative cwd resolves there. Connect verifies prerequisites and saves a session
profile without installing anything.

Use the loopback arguments below for this machine. SSH must already listen and
authorize this user; do not enable it or change authentication/host-key checks
without authorization.

Configured hosts and Tailscale machines appear below. Discovery does not verify
SSH access; pass a non-null target to remote_connect with the SSH username.
Discovery failure does not prevent using an explicit host or OpenSSH alias.`,
  },
  helper: {
    tools: ["remote_helper"],
    text: `Inspect first with action:inspect, then preview with action:plan and
operation:install|upgrade|uninstall. Both work over SSH without the helper.

Native installs require a trusted package for the target distro, release and
architecture. Build it in that distro environment with packages/omp-helper's
bun run package:native --help; set SOURCE_DATE_EPOCH to the revision timestamp
and increment --release for rebuilds. Transfer the artifact over SSH, then pass
its absolute remote path and sha256. Keep the original package's full
version/release and architecture for recovery; no public repository is assumed.

macOS uses a jobs-only Homebrew payload: build with bun run package:darwin
--output DIRECTORY on the target Mac using the package.json-pinned Bun, gtar
and patch. Use the pinned executable explicitly if PATH selects an older Bun.
Stage the archive and sha256 with manager:brew. The existing 4evy/dotfiles
local tap must contain Formula/omp-helper.rb. No sudo, launchd service or
desktop grants are required.
After applying updated extension sources, reload OMP before using the tools;
an existing session retains its loaded extension code.

Nix requires an already realized store output in artifact. Immutable
bootc/rpm-ostree hosts require existing Nix; native changes are refused.
The tool never installs a package manager or adds repositories.
Linux native transactions use managed sudo; activation runs as the connected
user, never root. Coordinate shared native upgrades/removals with other users.

Upgrade refuses live jobs/control leases. On failure, inspect package state
before resuming with maintenanceToken; restore the original package before
action:upgrade with subcommand:cancel (CLI: omp-helper upgrade cancel).
Transactions do not roll back automatically.
Uninstall deactivates this user's helper; Nix removes only helper-owned roots.
History is retained.`,
  },
  run: {
    tools: ["remote_run"],
    text: `Pass connection, command and shell:bash|zsh (default bash). Connect reports
available interpreters; reconnect older profiles to discover Zsh. cwd defaults
to the saved connection;
set it explicitly for same-machine work. waitSeconds limits observation, timeout
limits execution (0 means no deadline), and ready matches output with a regex.
Completion arrives automatically. Use the returned handle with remote_job,
not proc://.

PTY defaults on; disable it for plain output. Defaults: 120x40, timeout:0,
waitSeconds:10 (30 with readiness), lifetime:session. Load interactive for TUIs.

The gateway supplies a small base environment without inherited credentials or
SSH forwarding. login:true opts into the selected shell's login startup files;
otherwise Bash skips profiles/rc files and Zsh uses -f (system zshenv may still
run). envFiles sources up to 16 remote shell scripts with auto-export, in order,
then env exports custom variables, then command runs. envFiles paths resolve
against the connection cwd; startup and sourcing execute remote code.
Use shell-compatible assignment files, not arbitrary dotenv syntax.

env permits up to 64 valid shell identifiers with NUL-free values of at most
32,768 characters. Explicit values override startup/files and are stored in
launch arguments; use remote envFiles for secrets. A missing/failed source
stops before command. For example: {shell:"zsh",envFiles:["~/project/env.sh"],
env:{APP_MODE:"development"},command:"print -r -- $APP_MODE"}.
The result reports the actual interpreter. compact defaults true; raw:true
includes unread terminal redraw logs instead of hiding them.`,
  },
  jobs: {
    tools: ["remote_job"],
    text: `Use the exact returned handle. Actions: ${Object.keys(JOB_ACTIONS).join(", ")}.
Logs, waits, input responses and notifications share a persisted unread byte
cursor. Omit cursor to read only new output. Pass cursor:0 for explicit replay;
replay never rewinds shared consumption. lines limits display, not advancement.
Rotation and response-limit gaps are reported. Partial UTF-8 bytes survive
session restoration. screen replays a styled, versioned terminal frame.
wait can match an output regex. Completion uses the next agent step boundary,
without interrupting tools; finishedAt and deliveredAt show dispatch delay.

interrupt requests SIGINT; stop requests broker termination with escalation;
force requests SIGKILL. Deadline records distinguish actual timeout signals
from an ordinary command exiting 124. Leader exit is authoritative; child
cleanup stays unknown when the runtime cannot prove it. Tracked processes no
longer observable are reported separately, never as proof every child is gone.
mode chooses session or persist. Persist survives client/SSH loss, not broker
restart or reboot; while live, it also keeps session jobs in its scope alive.
Session/branch changes detach clients. Branch ownership determines control.
Reconnect the same profile/session to recover its screen and unread output.

Inspect interrupted starts rather than resend them. Transport loss proves
neither cancellation nor completion. Input actionId receipts persist before
sending: not-sent, sent-outcome-unknown, or processed. Processed means the broker
accepted input and returned a screen, not application acknowledgement.
Recover with {action:"receipt",job:"HANDLE",actionId:"ID"}; duplicate IDs return
the original receipt and never send again. Recovered screens are historical,
not evidence of current focus. Old SSH-backed history is not controllable.
Load interactive for input and screen examples.`,
  },
  interactive: {
    tools: ["remote_run", "remote_job"],
    text: `Start with pty:true and waitSeconds:0. Observe the prompt with logs or wait
and pattern before answering.

reply sends data plus Enter: {action:"reply",job:"HANDLE",data:"y"}.
password sends plaintext plus Enter; omit data for a cancellable text dialog
in interactive OMP. input sends bytes without Enter. keys sends named keys:
{action:"keys",job:"HANDLE",keys:["Down","Down","Enter"]}.

Supported keys: ${TERMINAL_KEYS}.
screen and input results include ANSI-styled rows, screenVersion and settled.
Set columns/rows at launch or resize:
{action:"resize",job:"HANDLE",columns:160,rows:50}.
settleMs defaults to 100; maxWaitMs defaults to 500 and bounds the settling
window even for spinners. Initial snapshot acquisition is separately bounded
to max(1000,maxWaitMs). settled:false means the screen is still changing.
waitSeconds on input sets the settling budget, capped at 5000 milliseconds.
Pass expectedScreenVersion from the frame you inspected to reject stale input.

Checked sequences require 1–20 steps, each with keys and a post-step expect
regex, and stop on mismatch, uncertainty or an unstable intermediate screen:
{action:"sequence",job:"HANDLE",steps:[{keys:["Down"],expect:"selected item"},
{keys:["Enter"],expect:"details"}]}. They also recheck the preceding frame before
the next step. Supply actionId (at most 100 characters for sequences) to recover
step receipts as ID:0, ID:1, etc.; never treat a sequence as a blind macro.
TERM comes from the gateway environment (native default: xterm-256color).`,
  },
  sudo: {
    tools: ["remote_sudo"],
    text: `Use remote_sudo for privileged commands. Authentication tries /etc/bleh,
cached sudo, then a bounded plaintext prompt or explicit password.
Passwords go only to stdin, never argv, environment or job records.
Missing/cancelled credentials stop the waiting job. Distinguish authentication
failure from an unknown command outcome; do not blindly rerun commands.
timeout defaults to 60 seconds and survives client loss. Sudo has no public job
handle or PTY; use remote_run with a PTY for interactive programs.`,
  },
  desktop: {
    tools: ["remote_desktop"],
    text: `inspect reports available/requestable/granted operations without consent.
Only inspect is read-approved; other actions require exec. The helper needs a
real Wayland user session; SSH does not grant desktop permissions.

open launches a native URI handler on an isolated GNOME workspace without
switching desktops; dialogs and child windows stay there. Requires GNOME 50,
the OMP workspace adapter, static workspaces on all monitors and a supported
new-instance handler. Adapter updates require a new login; no portal-opener
fallback. macOS has normal GUI behavior, not isolated Spaces.
Release with action:"release-workspace" and the returned workspaceId.
Closing the channel also releases launches; occupied workspaces are retained.

authorize requests capture/control consent for a user-selected monitor/window.
Set outputName when direct input needs explicit output identity. release closes
control and releases held input, not workspaces. Load screenshots or input next.`,
  },
  screenshots: {
    tools: ["remote_screenshot"],
    text: `Capture a user-selected monitor/window on a saved connection. The result
contains an image and session/frame geometry metadata. Capture alone grants no
input; authorize combined capture/control, then recapture for new identifiers.

Only the latest frame with current geometry can drive input. Without an
authoritative mapping, logicalGeometry is null and pointer input fails.
Resize, rotation, hotplug, session closure or disconnection invalidates
coordinates; recapture rather than reuse them.

Off-machine screenshots use the helper runtime's built-in Zstandard codec.
Loopback and this machine's interface endpoints bypass compression, including
via aliases.`,
  },
  input: {
    tools: ["remote_input"],
    text: `Input requires exec approval and an explicitly authorized sessionId.
Pointer actions need frame:{streamId,frameId} from its latest capture and pixel
coordinates within that image. authorization-required means no input ran:
authorize, then recapture. Stale/ambiguous frames fail before input.

Never replay interrupted input. partial-input may already have affected the
app; inspect it again. Success means backend submission, not app acceptance.
Check text receipts: mechanism, clipboardChanged, submittedBytes and partial.
Unicode uses EI text or explicit clipboard paste; paste_key defaults to Ctrl+V,
with Ctrl+Shift+V for terminals when needed. Paste can enter clipboard history
and does not restore old contents. Missing text support fails before partial entry.`,
  },
  files: {
    tools: ["remote_read", "remote_write", "remote_edit", "remote_delete"],
    text: `Use remote_read, remote_write, remote_edit and remote_delete with a saved
connection and literal path. Absolute paths, ~/ and connection-relative paths
work with all saved credentials, including custom keys; no helper is required.
Remote reads/writes/edits reuse native OMP tools and SSH transfer primitives.
Files are limited to 16 MiB. remote_read accepts native selectors separately,
e.g. {connection:"server",path:"src/main.ts",selector:"1-100"}; directories
accept offset/limit. A read returns the complete file's sha256 even for a range.
remote_write creates parents and overwrites a file. remote_edit uses native
old_string/new_string replacement; ambiguous matches require replace_all:true.
Pass expectedHash from a read to reject stale content; edits recheck before
transfer, but the final check/write is not an atomic compare-and-swap.
remote_delete removes one file or symlink and refuses directories. Native
transfers preserve regular-file permissions; writing/editing a symlink replaces
the link. Existing-file writes copy from a staged transfer and are not atomic
against disk failure. Mutation transport failures can leave outcomes unknown;
inspect rather than automatically retry.

Native read/grep/glob/write can also use the saved ssh:// root when present.
For these URLs, paths are absolute; percent-encode literal ?, # and :.
Off-machine transfers require zstd on both endpoints' PATH, with no fallback.
The authenticated endpoint determines the bypass, regardless of alias:
127/8, ::1 and this machine's interface addresses transfer uncompressed.
Reads report truncation; decoding failure never commits a staged write.`,
  },
} as const;
