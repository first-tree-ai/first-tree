#!/bin/sh
set -eu

PORTABLE_CHANNEL="${FIRST_TREE_PORTABLE_CHANNEL:-prod}"
DOWNLOAD_BASE_URL="${FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-https://download.first-tree.ai/releases}"
DEFAULT_PREFIX="${HOME}/.local/share/first-tree/${PORTABLE_CHANNEL}"
DEFAULT_BIN_DIR="${HOME}/.local/bin"
PATH_MODE="auto"
REQUESTED_VERSION=""
PREFIX="$DEFAULT_PREFIX"
BIN_DIR="$DEFAULT_BIN_DIR"
PATH_UPDATED_PROFILE=""
ORIGINAL_PATH="${PATH:-}"

START_MARKER="# >>> first-tree portable >>>"
END_MARKER="# <<< first-tree portable <<<"

# The two assignments above (PORTABLE_CHANNEL / DOWNLOAD_BASE_URL) are rewritten
# per channel by renderInstallerForChannel() in scripts/portable/build-portable.mjs.
# Those replacements are regex-based and non-global: never repeat either
# assignment's exact shape anywhere else in this file, because only the first
# match is rewritten and a later duplicate would ship the unrewritten default.
# Downstream code must read $PORTABLE_CHANNEL / $DOWNLOAD_BASE_URL instead.

# ---------------------------------------------------------------------------
# Terminal UI.
#
# Deliberately duplicated in scripts/dev-install.sh rather than shared: this
# file is published as a single self-contained object and consumed through
# `curl ... | sh`, so it cannot source a helper library. Keep the two copies
# conceptually in sync.
#
# Output contract:
#   - Human status lines go to stdout, matching the behaviour that
#     apps/cli/tests/portable-builder.test.ts asserts on.
#   - Only redrawn frames (the download bar) go to stderr, and only when stderr
#     is a TTY, so a captured/redirected stdout never sees a carriage return.
#   - Colour wraps a whole line and is never spliced into the middle of a
#     message. Those tests match plain substrings without stripping ANSI, so a
#     spliced escape sequence would break them.
#   - `curl | sh` means stdin is the script itself, so capability detection
#     looks at stdout/stderr and never at stdin.
# ---------------------------------------------------------------------------
QUIET=0
SHOW_BANNER=1
UI_COLOR=0
UI_ANIM=0
UI_UNICODE=0
UI_WIDTH=80
UI_TICK=1
UI_STEP=0
UI_TOTAL_STEPS=9
UI_CURRENT_STEP=""
UI_BAR_ACTIVE=0

C_RESET=""
C_DIM=""
C_BOLD=""
C_BRAND=""
C_WARN=""
C_ERR=""

G_OK="[ok]"
G_FAIL="[!!]"
G_WARN="[!]"
G_DOWN=">>"
G_ARROW="->"
G_DOT="-"
G_ELLIPSIS="..."
G_BAR_FILL="#"
G_BAR_EMPTY="."

DOWNLOADER=""
SHA_TOOL=""
DOWNLOAD_PID=""
DOWNLOAD_IN_FLIGHT=0
DOWNLOAD_PENDING_SIGNAL=""
DAEMON_SERVICE_STATE="unknown"
# `daemon ensure-service` exits with this when it deliberately did nothing:
# unsupported platform, or no credentials yet and `login` owns starting the
# daemon. Mirrors ENSURE_SERVICE_DEFERRED_EXIT_CODE in
# apps/cli/src/commands/daemon/ensure-service.ts.
ENSURE_SERVICE_DEFERRED=3

usage() {
  cat <<EOF
Usage: sh install.sh [options]

Options:
  --version <version>       Install an immutable version instead of latest
  --prefix <path>           Install root (default: $DEFAULT_PREFIX)
  --bin-dir <path>          Shim directory (default: $DEFAULT_BIN_DIR)
  --no-path-edit            Do not edit shell startup files
  --path-mode <mode>        auto, prompt, or off (default: auto)
  --quiet, -q               Only print errors and the final summary
  --no-banner               Skip the startup banner
  --help                    Show this help

Environment:
  NO_COLOR                  Set to any value to disable coloured output

Colour, the progress bar and other animations are disabled automatically when
stdout/stderr is not a terminal. When piping this script, pass options after
'--', for example: curl -fsSL <url> | sh -s -- --quiet
EOF
}

# Suppressed by --quiet. Use for progress narration.
log() {
  [ "$QUIET" -eq 0 ] || return 0
  printf '%s\n' "$*"
}

# Always printed. Use for the final summary and actionable guidance.
say() {
  printf '%s\n' "$*"
}

die() {
  if [ "$UI_BAR_ACTIVE" -eq 1 ]; then
    printf '\r\033[K' >&2
    UI_BAR_ACTIVE=0
  fi
  if [ -n "$UI_CURRENT_STEP" ]; then
    printf '%s\n' "${C_ERR}  ${G_FAIL}  ${UI_CURRENT_STEP} failed${C_RESET}" >&2
  fi
  printf 'first-tree portable installer: %s\n' "$*" >&2
  exit 1
}

ui_detect() {
  if [ "$QUIET" -eq 0 ] && [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
    UI_COLOR=1
  fi
  if [ "$QUIET" -eq 0 ] && [ -t 2 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    UI_ANIM=1
  fi

  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *[Uu][Tt][Ff]*) UI_UNICODE=1 ;;
  esac

  # `tput cols` is unreliable here: inside a command substitution its stdout is
  # a pipe, so ncurses cannot ioctl the real terminal and silently returns the
  # terminfo default of 80. Duplicate a terminal descriptor first and let stty
  # ioctl that instead; dup'd descriptors keep the terminal's access mode, and
  # fd 9 is closed again so it never leaks into the CLI we exec later.
  ui_cols=""
  if [ -t 1 ]; then
    exec 9>&1
  elif [ -t 2 ]; then
    exec 9>&2
  fi
  if [ -t 1 ] || [ -t 2 ]; then
    ui_cols="$(stty size <&9 2>/dev/null | awk '{print $2}' || true)"
    exec 9>&-
  fi
  case "$ui_cols" in
    ''|*[!0-9]*) ui_cols="$(tput cols 2>/dev/null || true)" ;;
  esac
  case "$ui_cols" in
    ''|*[!0-9]*) ui_cols="${COLUMNS:-80}" ;;
  esac
  case "$ui_cols" in
    ''|*[!0-9]*) ui_cols=80 ;;
  esac
  [ "$ui_cols" -ge 20 ] || ui_cols=80
  UI_WIDTH="$ui_cols"

  if [ "$UI_COLOR" -eq 1 ]; then
    ui_depth="$(tput colors 2>/dev/null || printf '8')"
    case "$ui_depth" in
      ''|*[!0-9]*) ui_depth=8 ;;
    esac
    # Brand green: --brand oklch(0.72 0.17 150) in packages/web/src/index.css.
    if [ "$ui_depth" -ge 256 ]; then
      C_BRAND="$(printf '\033[38;5;42m')"
    else
      C_BRAND="$(printf '\033[32m')"
    fi
    C_RESET="$(printf '\033[0m')"
    C_DIM="$(printf '\033[2m')"
    C_BOLD="$(printf '\033[1m')"
    C_WARN="$(printf '\033[33m')"
    C_ERR="$(printf '\033[31m')"
  fi

  if [ "$UI_UNICODE" -eq 1 ]; then
    G_OK="✓"
    G_FAIL="✗"
    G_WARN="⚠"
    G_DOWN="⬇"
    G_ARROW="→"
    G_DOT="·"
    G_ELLIPSIS="…"
    G_BAR_FILL="█"
    G_BAR_EMPTY="░"
  fi

  # POSIX only guarantees integer sleeps; GNU and BSD sleep both accept
  # fractions, and detect_platform already restricts us to Linux and macOS.
  if sleep 0.2 2>/dev/null; then
    UI_TICK="0.2"
  else
    UI_TICK=1
  fi
}

ui_step() {
  UI_STEP=$((UI_STEP + 1))
  UI_CURRENT_STEP="$1"
  [ "$QUIET" -eq 0 ] || return 0
  printf '\n%s\n' "${C_BOLD}  [${UI_STEP}/${UI_TOTAL_STEPS}] $1${C_RESET}"
}

ui_kv() {
  [ "$QUIET" -eq 0 ] || return 0
  printf '%s        %-11s %s%s\n' "$C_DIM" "$1" "$2" "$C_RESET"
}

ui_detail() {
  [ "$QUIET" -eq 0 ] || return 0
  printf '%s        %s%s\n' "$C_DIM" "$*" "$C_RESET"
}

ui_ok() {
  [ "$QUIET" -eq 0 ] || return 0
  printf '%s  %s  %s%s\n' "$C_BRAND" "$G_OK" "$*" "$C_RESET"
}

ui_warn() {
  printf '%s  %s  %s%s\n' "$C_WARN" "$G_WARN" "$*" "$C_RESET"
}

ui_now() {
  date +%s 2>/dev/null || printf '0'
}

ui_elapsed() {
  ui_start="$1"
  ui_end="$(ui_now)"
  case "${ui_start}${ui_end}" in
    ''|*[!0-9]*) printf 'n/a'; return 0 ;;
  esac
  ui_secs=$((ui_end - ui_start))
  [ "$ui_secs" -ge 0 ] || ui_secs=0
  if [ "$ui_secs" -lt 60 ]; then
    printf '%ss' "$ui_secs"
  else
    printf '%sm %ss' "$((ui_secs / 60))" "$((ui_secs % 60))"
  fi
}

ui_bytes_human() {
  ui_bytes="$1"
  case "$ui_bytes" in
    ''|*[!0-9]*) printf '?'; return 0 ;;
  esac
  if [ "$ui_bytes" -ge 1048576 ]; then
    ui_tenths=$((ui_bytes * 10 / 1048576))
    printf '%s.%s MB' "$((ui_tenths / 10))" "$((ui_tenths % 10))"
  elif [ "$ui_bytes" -ge 1024 ]; then
    ui_tenths=$((ui_bytes * 10 / 1024))
    printf '%s.%s KB' "$((ui_tenths / 10))" "$((ui_tenths % 10))"
  else
    printf '%s B' "$ui_bytes"
  fi
}

# `stat` flags differ between macOS (-f%z) and Linux (-c%s); `wc -c` does not.
ui_file_bytes() {
  if [ ! -f "$1" ]; then
    printf '0'
    return 0
  fi
  ui_count="$(wc -c <"$1" 2>/dev/null | tr -d ' \n' || true)"
  case "$ui_count" in
    ''|*[!0-9]*) ui_count=0 ;;
  esac
  printf '%s' "$ui_count"
}

ui_sha_short() {
  printf '%.12s%s' "$1" "$G_ELLIPSIS"
}

ui_repeat() {
  ui_i=0
  while [ "$ui_i" -lt "$2" ]; do
    printf '%s' "$1"
    ui_i=$((ui_i + 1))
  done
}

ui_render_bar() {
  ui_cur="$1"
  ui_total="$2"
  [ "$ui_total" -gt 0 ] || return 0
  [ "$ui_cur" -le "$ui_total" ] || ui_cur="$ui_total"
  ui_pct=$((ui_cur * 100 / ui_total))
  ui_barw=$((UI_WIDTH - 38))
  [ "$ui_barw" -ge 10 ] || ui_barw=10
  [ "$ui_barw" -le 40 ] || ui_barw=40
  ui_filled=$((ui_cur * ui_barw / ui_total))
  printf '\r\033[K     [%s%s] %3s%%   %s / %s' \
    "$(ui_repeat "$G_BAR_FILL" "$ui_filled")" \
    "$(ui_repeat "$G_BAR_EMPTY" "$((ui_barw - ui_filled))")" \
    "$ui_pct" \
    "$(ui_bytes_human "$ui_cur")" \
    "$(ui_bytes_human "$ui_total")" >&2
}

print_banner() {
  [ "$SHOW_BANNER" -eq 1 ] || return 0
  [ "$QUIET" -eq 0 ] || return 0
  if [ "$UI_UNICODE" -ne 1 ] || [ ! -t 1 ] || [ "$UI_WIDTH" -lt 60 ]; then
    printf '\n%s\n' "${C_BRAND}  first-tree ${G_DOT} portable installer ${G_DOT} https://first-tree.ai${C_RESET}"
    printf '%s\n' "${C_DIM}  ${PORTABLE_CHANNEL} ${G_DOT} ${PLATFORM}${C_RESET}"
    return 0
  fi
  printf '%s' "$C_BRAND"
  cat <<'BANNER'

     ▄█▄
    █████     ╔═╗╦╦═╗╔═╗╔╦╗  ╔╦╗╦═╗╔═╗╔═╗
   ▄█████▄    ╠╣ ║╠╦╝╚═╗ ║    ║ ╠╦╝║╣ ║╣
    █████     ╚  ╩╩╚═╚═╝ ╩    ╩ ╩╚═╚═╝╚═╝
   ▄█████▄
  ▄███████▄   Context-grounded agentic work for teams.
     ███      https://first-tree.ai
BANNER
  printf '%s' "$C_RESET"
  printf '%s\n' "${C_DIM}              ${PORTABLE_CHANNEL} ${G_DOT} ${PLATFORM} ${G_DOT} portable installer${C_RESET}"
}

need_value() {
  [ "$#" -ge 2 ] || die "$1 requires a value"
  case "$2" in
    --*) die "$1 requires a value" ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      need_value "$1" "${2:-}"
      REQUESTED_VERSION="$2"
      shift 2
      ;;
    --prefix)
      need_value "$1" "${2:-}"
      PREFIX="$2"
      shift 2
      ;;
    --bin-dir)
      need_value "$1" "${2:-}"
      BIN_DIR="$2"
      shift 2
      ;;
    --no-path-edit)
      PATH_MODE="off"
      shift
      ;;
    --path-mode)
      need_value "$1" "${2:-}"
      case "$2" in
        auto|prompt|off) PATH_MODE="$2" ;;
        *) die "--path-mode must be auto, prompt, or off" ;;
      esac
      shift 2
      ;;
    --quiet|-q)
      QUIET=1
      SHOW_BANNER=0
      shift
      ;;
    --no-banner)
      SHOW_BANNER=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$PREFIX" in
  /*) ;;
  *) die "--prefix must be an absolute path" ;;
esac
case "$BIN_DIR" in
  /*) ;;
  *) die "--bin-dir must be an absolute path" ;;
esac

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

trim_slashes() {
  printf '%s' "$1" | sed 's:/*$::'
}

# Resolved once in the foreground so download_to never has to `die`. A `die`
# inside the backgrounded download would only exit that subshell, and the
# progress loop would then misreport a missing tool as a failed transfer.
resolve_downloader() {
  if command_exists curl; then
    DOWNLOADER="curl"
  elif command_exists wget; then
    DOWNLOADER="wget"
  else
    die "curl or wget is required"
  fi
}

resolve_sha_tool() {
  if command_exists sha256sum; then
    SHA_TOOL="sha256sum"
  elif command_exists shasum; then
    SHA_TOOL="shasum"
  else
    die "sha256sum or shasum is required"
  fi
}

# Replaces the calling process with the transfer itself. Backgrounded with `&`
# this makes `$!` the curl/wget pid rather than a wrapper shell's, which is what
# lets cancellation reach the transfer instead of orphaning it.
exec_downloader() {
  case "$DOWNLOADER" in
    curl) exec curl -fsSL "$1" -o "$2" ;;
    wget) exec wget -qO "$2" "$1" ;;
  esac
  return 1
}

# Every transfer runs through here, terminal or not: which process owns the
# download must not depend on whether a progress bar is being drawn. `render`
# only decides what is printed. Returns the transfer's exit status.
run_download() {
  rd_url="$1"
  rd_dest="$2"
  rd_expected="$3"
  rd_render="$4"

  # A signal can arrive between forking the transfer and recording $! below.
  # Acting on it there would leave the child unowned — and before it reaches
  # `exec` it still carries this shell's command name, so it cannot be found by
  # inspecting the process table either. Record the signal instead and honour it
  # once the pid is captured.
  DOWNLOAD_PENDING_SIGNAL=""
  trap 'DOWNLOAD_PENDING_SIGNAL=1' HUP INT TERM
  DOWNLOAD_IN_FLIGHT=1
  exec_downloader "$rd_url" "$rd_dest" &
  DOWNLOAD_PID=$!
  trap 'cleanup; exit 130' HUP INT TERM
  if [ -n "$DOWNLOAD_PENDING_SIGNAL" ]; then
    cleanup
    exit 130
  fi

  if [ "$rd_render" -eq 1 ]; then
    UI_BAR_ACTIVE=1
  fi
  while kill -0 "$DOWNLOAD_PID" 2>/dev/null; do
    if [ "$rd_render" -eq 1 ]; then
      ui_render_bar "$(ui_file_bytes "$rd_dest")" "$rd_expected"
    fi
    sleep "$UI_TICK"
  done

  rd_rc=0
  wait "$DOWNLOAD_PID" || rd_rc=$?
  DOWNLOAD_PID=""
  DOWNLOAD_IN_FLIGHT=0

  if [ "$rd_render" -eq 1 ]; then
    if [ "$rd_rc" -eq 0 ]; then
      ui_render_bar "$rd_expected" "$rd_expected"
      printf '\n' >&2
    fi
    UI_BAR_ACTIVE=0
  fi
  return "$rd_rc"
}

download_to() {
  run_download "$1" "$2" "" 0
}

# Byte-level progress driven by the asset size already present in the release
# metadata, so curl, wget and busybox wget all render identically. Only the
# rendering differs from any other transfer; run_download owns the child and
# reads its status the same way either way.
download_with_progress() {
  dl_url="$1"
  dl_dest="$2"
  dl_expected="$3"

  dl_render=0
  if [ "$UI_ANIM" -eq 1 ]; then
    case "$dl_expected" in
      ''|*[!0-9]*) ;;
      *)
        if [ "$dl_expected" -gt 0 ]; then
          dl_render=1
        fi
        ;;
    esac
  fi

  if run_download "$dl_url" "$dl_dest" "$dl_expected" "$dl_render"; then
    return 0
  fi
  die "download failed: $dl_url"
}

sha256_file() {
  file="$1"
  case "$SHA_TOOL" in
    sha256sum) sha256sum "$file" | awk '{print $1}' ;;
    shasum) shasum -a 256 "$file" | awk '{print $1}' ;;
    *) return 1 ;;
  esac
}

extract_tarball() {
  tarball="$1"
  dest="$2"
  if tar --version 2>/dev/null | grep -qi "GNU tar"; then
    tar --warning=no-unknown-keyword -xzf "$tarball" -C "$dest"
  else
    tar -xzf "$tarball" -C "$dest"
  fi
}

json_string() {
  file="$1"
  key="$2"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | sed -n '1p'
}

json_number() {
  file="$1"
  key="$2"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$file" | sed -n '1p'
}

asset_block() {
  file="$1"
  platform="$2"
  awk -v needle="\"platform\": \"${platform}\"" '
    $0 ~ needle { found = 1 }
    found { print }
    found && $0 ~ /}/ { exit }
  ' "$file"
}

detect_platform() {
  os="$(uname -s 2>/dev/null || true)"
  machine="$(uname -m 2>/dev/null || true)"
  case "$os" in
    Darwin) portable_os="darwin" ;;
    Linux) portable_os="linux" ;;
    *) die "unsupported platform: ${os:-unknown}. Download and extract a matching portable tarball manually." ;;
  esac
  case "$machine" in
    arm64|aarch64) portable_arch="arm64" ;;
    x86_64|amd64) portable_arch="x64" ;;
    *) die "unsupported architecture: ${machine:-unknown}. Download and extract a matching portable tarball manually." ;;
  esac
  printf '%s-%s' "$portable_os" "$portable_arch"
}

shell_single_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\"'\"'/g"
  printf "'"
}

write_shim() {
  path="$1"
  current_root="$2"
  bin_dir="$3"
  tmp="${path}.$$"
  root_literal="$(shell_single_quote "$current_root")"
  bin_literal="$(shell_single_quote "$bin_dir")"
  cat >"$tmp" <<EOF
#!/bin/sh
set -eu
root=$root_literal
bin_dir=$bin_literal
export FIRST_TREE_INSTALL_MODE=portable
export FIRST_TREE_PORTABLE_ROOT="\$root"
export FIRST_TREE_PORTABLE_BIN_DIR="\$bin_dir"
exec "\$root/node/bin/node" "\$root/app/cli/index.mjs" "\$@"
EOF
  chmod 755 "$tmp"
  mv -f "$tmp" "$path"
}

atomic_replace_current_link() {
  new_link="$1"
  current_link="$2"
  os="$(uname -s 2>/dev/null || true)"
  case "$os" in
    Linux)
      if mv -f -T "$new_link" "$current_link"; then
        return 0
      fi
      ;;
    Darwin)
      if mv -f -h "$new_link" "$current_link"; then
        return 0
      fi
      ;;
    *)
      rm -f "$new_link"
      die "unsupported platform for atomic current replacement: ${os:-unknown}"
      ;;
  esac

  rm -f "$new_link"
  die "failed to atomically replace $current_link"
}

path_contains_bin_dir() {
  path_value="$1"
  case ":${path_value}:" in
    *:"$BIN_DIR":*) return 0 ;;
    *) return 1 ;;
  esac
}

portable_shim_wins_on_original_path() {
  bin_name="$1"
  old_path="${PATH:-}"
  PATH="$ORIGINAL_PATH"
  resolved="$(command -v "$bin_name" 2>/dev/null || true)"
  PATH="$old_path"
  [ "$resolved" = "$BIN_DIR/$bin_name" ]
}

profile_for_shell() {
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh) printf '%s/.zshrc' "$HOME" ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        printf '%s/.bashrc' "$HOME"
      else
        printf '%s/.bash_profile' "$HOME"
      fi
      ;;
    sh|dash|ksh) printf '%s/.profile' "$HOME" ;;
    *) return 1 ;;
  esac
}

rewrite_path_block() {
  profile="$1"
  tmp="${profile}.$$"
  if [ -f "$profile" ]; then
    awk -v start="$START_MARKER" -v end="$END_MARKER" '
      $0 == start { skip = 1; next }
      $0 == end { skip = 0; next }
      skip != 1 { print }
    ' "$profile" >"$tmp"
  else
    : >"$tmp"
  fi
  {
    cat "$tmp"
    printf '\n%s\n' "$START_MARKER"
    printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
    printf '%s\n' "$END_MARKER"
  } >"${tmp}.new"
  mv -f "${tmp}.new" "$profile"
  rm -f "$tmp"
}

maybe_edit_path() {
  bin_name="$1"
  if [ "$PATH_MODE" = "off" ]; then
    ui_detail "PATH editing disabled by --no-path-edit / --path-mode off"
    return 0
  fi
  if path_contains_bin_dir "$ORIGINAL_PATH" && portable_shim_wins_on_original_path "$bin_name"; then
    ui_detail "$BIN_DIR already takes precedence on PATH"
    return 0
  fi

  if ! profile="$(profile_for_shell)"; then
    ui_detail "Automatic PATH setup skipped: this shell is not recognized."
    return 0
  fi

  if [ "$PATH_MODE" = "prompt" ]; then
    if [ ! -t 0 ]; then
      ui_detail "Automatic PATH setup skipped because prompt mode requires an interactive shell."
      return 0
    fi
    printf 'Add %s to PATH in %s? [Y/n] ' "$BIN_DIR" "$profile"
    read answer || answer="n"
    case "$answer" in
      ""|y|Y|yes|YES) ;;
      *)
        ui_detail "Skipped PATH setup."
        return 0
        ;;
    esac
  fi

  if rewrite_path_block "$profile"; then
    PATH_UPDATED_PROFILE="$profile"
    ui_detail "Updated PATH block in $profile"
  else
    ui_warn "PATH setup failed for $profile."
  fi
}

print_path_guidance() {
  # The three messages below are asserted verbatim (plain substring, no ANSI
  # stripping) by apps/cli/tests/portable-builder.test.ts. Never colour them
  # mid-line and never emit them outside their own branch.
  if [ -n "$PATH_UPDATED_PROFILE" ]; then
    say "  Restart your shell, or run: . \"$PATH_UPDATED_PROFILE\""
  elif path_contains_bin_dir "$ORIGINAL_PATH"; then
    # Judge against the user's incoming PATH: the installer prepends BIN_DIR
    # to its own PATH for recovery, which says nothing about the user's shell.
    say "  $BIN_NAME should be available now."
  else
    say "  Add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\""
  fi
}

# Version of the complete portable install `$PREFIX/current` points at, or
# nothing when the prefix is empty, half-written, or dangling. Callers treat an
# empty result as "not installed yet" and fall through to the normal install
# path, which is also the repair path.
installed_portable_version() {
  current_link="$PREFIX/current"
  [ -L "$current_link" ] || return 0
  [ -f "$current_link/VERSION" ] || return 0
  [ -x "$current_link/node/bin/node" ] || return 0
  [ -f "$current_link/app/cli/index.mjs" ] || return 0
  installed="$(tr -d '[:space:]' <"$current_link/VERSION")"
  [ -n "$installed" ] || return 0
  printf '%s\n' "$installed"
}

# A shim only counts as installed when it is one of ours and points at this
# prefix. Otherwise a re-run with a different --prefix would skip the install
# and leave `first-tree` resolving to the other prefix.
shim_installed_for_prefix() {
  shim="$1"
  [ -x "$shim" ] || return 1
  grep -q "FIRST_TREE_PORTABLE_ROOT" "$shim" 2>/dev/null || return 1
  grep -qF "root=$(shell_single_quote "$PREFIX/current")" "$shim" 2>/dev/null
}

# Shared tail for both the fresh install and the already-installed fast path:
# wire PATH + the background service, then print the summary. Keeping one copy
# means the two paths cannot drift on the lines the install tests assert.
# $1 = outcome (e.g. "installed", "is already installed")
# $2 = detail line under the headline
finish_portable_install() {
  finish_outcome="$1"
  finish_detail="$2"
  ui_step "PATH and background service"
  PATH="$BIN_DIR:${PATH:-}"
  export PATH
  maybe_edit_path "$BIN_NAME"
  ensure_daemon_service "$BIN_NAME"
  # Only claim the service is set up when it actually is. ensure_daemon_service
  # deliberately does not fail the install, so neither its "run login" notice nor
  # its warning may be followed by a success line contradicting it.
  case "$DAEMON_SERVICE_STATE" in
    ready) ui_ok "Shell and background service are set up" ;;
    deferred) ui_detail "Install is complete; the background service starts after login." ;;
    *) ui_detail "Install is complete; background service setup still needs login." ;;
  esac

  say ""
  say "${C_BRAND}${C_BOLD}  $G_OK  First Tree $VERSION ${finish_outcome}$C_RESET"
  say "${C_DIM}        ${finish_detail}${C_RESET}"
  say ""
  say "  Command: $BIN_DIR/$BIN_NAME"
  print_path_guidance
  say ""
  say "  Next:"
  say "    $BIN_DIR/$BIN_NAME login <connect-code>"
  say ""
}

clean_npm_temp_residue() {
  package_name="$1"
  case "$package_name" in
    first-tree|first-tree-staging) ;;
    *) return 0 ;;
  esac
  command_exists npm || return 0

  npm_root="$(npm root -g 2>/dev/null | sed -n '1p' || true)"
  [ -n "$npm_root" ] || return 0
  [ -d "$npm_root" ] || return 0

  for residue in "$npm_root/.$package_name"-*; do
    [ -e "$residue" ] || continue
    [ -d "$residue" ] || continue
    rm -rf "$residue"
    ui_detail "Removed stale npm temp directory: $residue"
  done
}

# Captured rather than streamed so --quiet can hold back a successful lifecycle
# line, and so the caller can tell whether the service is actually up.
#
# Exit status is a three-state contract, not a boolean: `ensure-service`
# deliberately does nothing when the platform has no service control or when no
# credentials exist yet, and that deferred case is the normal first install.
# Reporting it as ready would contradict the command's own "run login" output.
ensure_daemon_service() {
  bin_name="$1"
  ensure_service_output=""
  ensure_service_rc=0
  ensure_service_output="$("$BIN_DIR/$bin_name" daemon ensure-service 2>&1)" || ensure_service_rc=$?

  if [ "$ensure_service_rc" -eq 0 ]; then
    DAEMON_SERVICE_STATE="ready"
    [ -z "$ensure_service_output" ] || log "$ensure_service_output"
    return 0
  fi
  if [ "$ensure_service_rc" -eq "$ENSURE_SERVICE_DEFERRED" ]; then
    DAEMON_SERVICE_STATE="deferred"
    [ -z "$ensure_service_output" ] || log "$ensure_service_output"
    return 0
  fi

  DAEMON_SERVICE_STATE="failed"
  [ -z "$ensure_service_output" ] || printf '%s\n' "$ensure_service_output" >&2
  ui_warn "Background service repair failed or is not available yet."
  say "  Run $BIN_DIR/$bin_name login <code> to refresh credentials and service state."
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/first-tree-portable.XXXXXX")"
# Cancellation owns the transfer itself and has to see it gone before WORK_DIR
# disappears underneath it. DOWNLOAD_PID is always set whenever a transfer
# exists: run_download defers signal handling across the fork so this can never
# be reached with a live-but-unrecorded child.
stop_download() {
  [ "$DOWNLOAD_IN_FLIGHT" -eq 1 ] || return 0
  DOWNLOAD_IN_FLIGHT=0
  [ -n "$DOWNLOAD_PID" ] || return 0

  kill "$DOWNLOAD_PID" 2>/dev/null || true
  wait "$DOWNLOAD_PID" 2>/dev/null || true

  stop_wait=0
  while [ "$stop_wait" -lt 10 ] && kill -0 "$DOWNLOAD_PID" 2>/dev/null; do
    sleep "$UI_TICK"
    stop_wait=$((stop_wait + 1))
  done
  if kill -0 "$DOWNLOAD_PID" 2>/dev/null; then
    kill -9 "$DOWNLOAD_PID" 2>/dev/null || true
  fi
  DOWNLOAD_PID=""
}

cleanup() {
  stop_download
  if [ "$UI_BAR_ACTIVE" -eq 1 ]; then
    printf '\r\033[K\n' >&2
    UI_BAR_ACTIVE=0
  fi
  rm -rf "$WORK_DIR"
}
# Split from the EXIT trap on purpose: a bare `trap cleanup INT` runs cleanup
# and then *resumes* the script, so Ctrl-C used to delete the work directory out
# from under an install that kept going. Abort explicitly instead. cleanup is
# idempotent, so the EXIT trap re-running it is harmless.
trap cleanup EXIT
trap 'cleanup; exit 130' HUP INT TERM

PLATFORM="$(detect_platform)"
ui_detect
print_banner
TOTAL_START="$(ui_now)"

ui_step "Preflight"
resolve_downloader
resolve_sha_tool
command_exists tar || die "tar is required"
ui_kv "Channel" "$PORTABLE_CHANNEL"
ui_kv "Platform" "$PLATFORM"
ui_kv "Prefix" "$PREFIX"
ui_kv "Bin dir" "$BIN_DIR"
ui_kv "Tools" "$DOWNLOADER, $SHA_TOOL, tar"
ui_ok "Environment ready"

BASE="$(trim_slashes "$DOWNLOAD_BASE_URL")"
if [ -n "$REQUESTED_VERSION" ]; then
  MANIFEST_URL="${BASE}/${PORTABLE_CHANNEL}/${REQUESTED_VERSION}/manifest.json"
else
  MANIFEST_URL="${BASE}/${PORTABLE_CHANNEL}/latest.json"
fi

MANIFEST_FILE="$WORK_DIR/manifest.json"
ui_step "Fetching release metadata"
ui_kv "Source" "$MANIFEST_URL"
STEP_START="$(ui_now)"
download_to "$MANIFEST_URL" "$MANIFEST_FILE"
ui_ok "Metadata received in $(ui_elapsed "$STEP_START")"

ui_step "Resolving version and asset"
VERSION="$(json_string "$MANIFEST_FILE" version)"
PACKAGE_NAME="$(json_string "$MANIFEST_FILE" packageName)"
BIN_NAME="$(json_string "$MANIFEST_FILE" binName)"
ALIAS_NAME="$(json_string "$MANIFEST_FILE" aliasName)"
[ -n "$VERSION" ] || die "metadata missing version"
[ -n "$PACKAGE_NAME" ] || die "metadata missing packageName"
[ -n "$BIN_NAME" ] || die "metadata missing binName"
[ -n "$ALIAS_NAME" ] || die "metadata missing aliasName"

ASSET_FILE="$WORK_DIR/asset.json"
asset_block "$MANIFEST_FILE" "$PLATFORM" >"$ASSET_FILE"
ASSET_PLATFORM="$(json_string "$ASSET_FILE" platform)"
ASSET_URL="$(json_string "$ASSET_FILE" url)"
ASSET_SHA="$(json_string "$ASSET_FILE" sha256)"
ASSET_SIZE="$(json_number "$ASSET_FILE" size)"
[ "$ASSET_PLATFORM" = "$PLATFORM" ] || die "no portable asset for $PLATFORM"
[ -n "$ASSET_URL" ] || die "asset missing url"
[ -n "$ASSET_SHA" ] || die "asset missing sha256"
[ -n "$ASSET_SIZE" ] || die "asset missing size"
ui_kv "Version" "$VERSION"
ui_kv "Package" "$PACKAGE_NAME"
ui_kv "Command" "$BIN_NAME ($ALIAS_NAME)"
ui_kv "Download" "$(ui_bytes_human "$ASSET_SIZE")"
ui_kv "SHA-256" "$(ui_sha_short "$ASSET_SHA")"
ui_ok "Resolved $BIN_NAME $VERSION for $PLATFORM"

# Re-running the installer on an up-to-date machine is the documented
# install-or-upgrade path, so it must not fetch the payload (tens of MB with the
# bundled Node runtime) only to discard it. Skip only when every moving part is
# already in place; a missing link, runtime or shim falls through to the normal
# path, which doubles as the repair path.
INSTALLED_VERSION="$(installed_portable_version)"
if [ -n "$INSTALLED_VERSION" ] && [ "$INSTALLED_VERSION" = "$VERSION" ] &&
  shim_installed_for_prefix "$BIN_DIR/$BIN_NAME" &&
  shim_installed_for_prefix "$BIN_DIR/$ALIAS_NAME"; then
  ui_ok "$BIN_NAME $VERSION is already installed; skipped the payload download"
  finish_portable_install "is already up to date" \
    "$PREFIX/current $G_ARROW $PREFIX/versions/$VERSION $G_DOT nothing to download"
  exit 0
fi

# Dev/dogfood machines run a `local.*` build, which compares unequal to every
# released version, so a plain re-run replaces it. That is intended, but it must
# never be silent: `upgrade` treats local builds as ahead and refuses instead.
case "$INSTALLED_VERSION" in
  local.*) ui_warn "Replacing local build $INSTALLED_VERSION with released $VERSION" ;;
esac

clean_npm_temp_residue "$PACKAGE_NAME"
mkdir -p "$PREFIX/versions" "$PREFIX/.tmp" "$BIN_DIR"
# Store one lexical absolute-path contract in shims and metadata consumers.
# `pwd -L` removes trailing slashes and dot segments without resolving a
# caller-selected symlink prefix, matching Node's path.resolve semantics.
PREFIX="$(CDPATH= cd -L "$PREFIX" && pwd -L)"
BIN_DIR="$(CDPATH= cd -L "$BIN_DIR" && pwd -L)"
TARBALL="$WORK_DIR/payload.tar.gz"

ui_step "Downloading payload"
log "${C_DIM}     ${G_DOWN}  $BIN_NAME $VERSION $G_DOT $(ui_bytes_human "$ASSET_SIZE") $G_DOT bundled Node.js runtime included${C_RESET}"
STEP_START="$(ui_now)"
download_with_progress "$ASSET_URL" "$TARBALL" "$ASSET_SIZE"
ui_ok "Downloaded $(ui_bytes_human "$(ui_file_bytes "$TARBALL")") in $(ui_elapsed "$STEP_START")"

ui_step "Verifying checksum"
ACTUAL_SHA="$(sha256_file "$TARBALL")"
if [ "$ACTUAL_SHA" != "$ASSET_SHA" ]; then
  die "checksum mismatch for portable payload: expected $ASSET_SHA, got $ACTUAL_SHA"
fi
ui_ok "Checksum verified  sha256:$(ui_sha_short "$ACTUAL_SHA")"

ui_step "Extracting and validating payload"
FINAL_VERSION_DIR="$PREFIX/versions/$VERSION"
TEMP_VERSION_DIR="$PREFIX/.tmp/${VERSION}.$$"
rm -rf "$TEMP_VERSION_DIR"
mkdir -p "$TEMP_VERSION_DIR"
extract_tarball "$TARBALL" "$TEMP_VERSION_DIR"

if [ -e "$FINAL_VERSION_DIR" ]; then
  # A version directory is only reusable when it is complete: the fast path
  # above already skips complete installs, so reaching here with one on disk
  # means the previous attempt was interrupted (or the runtime was removed).
  # Re-extracting repairs it; reusing it would fail the smoke check below.
  if [ -x "$FINAL_VERSION_DIR/node/bin/node" ] &&
    [ -f "$FINAL_VERSION_DIR/app/cli/index.mjs" ] &&
    [ -f "$FINAL_VERSION_DIR/INSTALL.json" ]; then
    rm -rf "$TEMP_VERSION_DIR"
    VALIDATION_DIR="$FINAL_VERSION_DIR"
    ui_detail "Version $VERSION is already unpacked, reusing $FINAL_VERSION_DIR"
  else
    ui_warn "Version $VERSION is on disk but incomplete; re-extracting"
    rm -rf "$FINAL_VERSION_DIR"
    VALIDATION_DIR="$TEMP_VERSION_DIR"
  fi
else
  VALIDATION_DIR="$TEMP_VERSION_DIR"
fi

INSTALL_FILE="$VALIDATION_DIR/INSTALL.json"
[ -f "$INSTALL_FILE" ] || die "portable payload missing INSTALL.json"
INSTALL_VERSION="$(json_string "$INSTALL_FILE" version)"
INSTALL_PACKAGE="$(json_string "$INSTALL_FILE" packageName)"
INSTALL_BIN="$(json_string "$INSTALL_FILE" binName)"
INSTALL_ALIAS="$(json_string "$INSTALL_FILE" aliasName)"
INSTALL_PLATFORM="$(json_string "$INSTALL_FILE" platform)"
INSTALL_MODE="$(json_string "$INSTALL_FILE" installMode)"
INSTALL_ENTRY="$(json_string "$INSTALL_FILE" appEntry)"
[ "$INSTALL_VERSION" = "$VERSION" ] || die "INSTALL.json version does not match downloaded metadata"
[ "$INSTALL_PACKAGE" = "$PACKAGE_NAME" ] || die "INSTALL.json packageName does not match downloaded metadata"
[ "$INSTALL_BIN" = "$BIN_NAME" ] || die "INSTALL.json binName does not match downloaded metadata"
[ "$INSTALL_ALIAS" = "$ALIAS_NAME" ] || die "INSTALL.json aliasName does not match downloaded metadata"
[ "$INSTALL_PLATFORM" = "$PLATFORM" ] || die "INSTALL.json platform does not match the current platform"
[ "$INSTALL_MODE" = "portable" ] || die "INSTALL.json does not describe a portable install"
[ "$INSTALL_ENTRY" = "app/cli/index.mjs" ] || die "INSTALL.json appEntry is unsupported"

if [ "$VALIDATION_DIR" = "$TEMP_VERSION_DIR" ]; then
  mv "$TEMP_VERSION_DIR" "$FINAL_VERSION_DIR"
fi
ui_kv "Unpacked" "$FINAL_VERSION_DIR"
ui_ok "Payload contents match the release metadata"

CURRENT_LINK="$PREFIX/current"
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  die "$CURRENT_LINK exists and is not a symlink"
fi
NEW_LINK="$PREFIX/.current.$$"

# Exercise the candidate runtime directly before changing stable shims or
# `current`. Once `current` moves, every remaining operation is best-effort or
# non-failing so installer success/failure always reflects the active version.
ui_step "Runtime smoke check"
if ! "$FINAL_VERSION_DIR/node/bin/node" "$FINAL_VERSION_DIR/app/cli/index.mjs" --version >/dev/null; then
  die "portable payload failed the pre-commit runtime smoke check"
fi
ui_ok "Bundled runtime starts and reports a version"

# Prepare both stable shims while current still names the old version. The
# current symlink is the final commit point, so a shim write failure never
# reports failure after activating the new runtime.
ui_step "Activating version"
write_shim "$BIN_DIR/$BIN_NAME" "$CURRENT_LINK" "$BIN_DIR"
write_shim "$BIN_DIR/$ALIAS_NAME" "$CURRENT_LINK" "$BIN_DIR"
rm -f "$NEW_LINK"
ln -s "$FINAL_VERSION_DIR" "$NEW_LINK"
atomic_replace_current_link "$NEW_LINK" "$CURRENT_LINK"
ui_kv "Shim" "$BIN_DIR/$BIN_NAME"
ui_kv "Shim" "$BIN_DIR/$ALIAS_NAME"
ui_kv "Current" "$CURRENT_LINK $G_ARROW $FINAL_VERSION_DIR"
ui_ok "$BIN_NAME $VERSION is now the active version"

finish_portable_install "installed" "$FINAL_VERSION_DIR $G_DOT completed in $(ui_elapsed "$TOTAL_START")"
