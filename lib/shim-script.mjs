export function generateShim(hccBin, realBin, tool) {
  if (tool.resumeFlag) {
    // Claude: --resume/--continue/--session-id/--fork-session aware wrapper.
    return `#!/usr/bin/env bash
# hello-cc shim for ${tool.name} (auto-generated; do not edit manually)
# Wraps ${tool.name} with hello-cc peer mesh integration.
# Real binary: ${realBin}

set -e
REAL_BIN="${realBin}"
HCC_BIN="${hccBin}"

if [ "\${HCC_SHIM_ENSURED:-}" != "1" ]; then
  set +e
  "$HCC_BIN" shim ensure "${tool.name}" "$0" >/dev/null 2>&1
  ENSURE_STATUS=$?
  set -e
  if [ "$ENSURE_STATUS" = "75" ]; then
    export HCC_SHIM_ENSURED=1
    exec "$0" "$@"
  fi
fi

should_passthrough() {
  for arg in "$@"; do
    case "$arg" in
      -h|--help|-v|--version|-p|--print|--bare|--safe-mode)
        return 0
        ;;
    esac
  done

  case "\${1:-}" in
    agents|auth|auto-mode|doctor|install|mcp|plugin|plugins|project|setup-token|ultrareview|update|upgrade)
      return 0
      ;;
  esac

  return 1
}

if should_passthrough "$@"; then
  exec "$REAL_BIN" "$@"
fi

# Use the current directory as the hello-cc project root unless HCC_ROOT is set.
HCC_ROOT=$("$HCC_BIN" find-root 2>/dev/null || true)

if [ -z "$HCC_ROOT" ]; then
  exec "$REAL_BIN" "$@"
fi

sanitize_peer_part() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g; s/^-*//; s/-*$//' | cut -c 1-32
}

tty_peer_part() {
  TTY_NUM=$(tty 2>/dev/null | tr -dc '0-9' | tail -c 4)
  PARENT_PID="\${PPID:-$$}"
  if [ -n "$TTY_NUM" ]; then
    printf '%s-%s' "$TTY_NUM" "$PARENT_PID"
  else
    printf '%s' "$PARENT_PID"
  fi
}

RESUME_ID=""
SESSION_ID=""
SESSION_NAME=""
IS_CONTINUE=0
IS_FORK=0
PREV_ARG=""
for arg in "$@"; do
  case "$PREV_ARG" in
    --resume|-r) RESUME_ID="$arg" ;;
    --session-id) SESSION_ID="$arg" ;;
    --name|-n) SESSION_NAME="$arg" ;;
  esac
  case "$arg" in
    --resume=*) RESUME_ID="\${arg#--resume=}" ;;
    --session-id=*) SESSION_ID="\${arg#--session-id=}" ;;
    --name=*) SESSION_NAME="\${arg#--name=}" ;;
    --continue|-c) IS_CONTINUE=1 ;;
    --fork-session) IS_FORK=1 ;;
  esac
  PREV_ARG="$arg"
done

if [ -n "$HCC_PEER" ]; then
  PEER_ID="$HCC_PEER"
elif [ -n "$SESSION_ID" ]; then
  PEER_ID="${tool.kind}-\$(sanitize_peer_part "\${SESSION_ID:0:8}")"
elif [ -n "$RESUME_ID" ] && [ "$IS_FORK" != "1" ]; then
  PEER_ID="${tool.kind}-\$(sanitize_peer_part "\${RESUME_ID:0:8}")"
elif [ -n "$CLAUDE_CODE_SESSION_ID" ]; then
  PEER_ID="${tool.kind}-\$(sanitize_peer_part "\${CLAUDE_CODE_SESSION_ID:0:8}")"
elif [ -n "$SESSION_NAME" ] && [ "$IS_FORK" != "1" ] && [ "$IS_CONTINUE" != "1" ]; then
  PEER_ID="${tool.kind}-\$(sanitize_peer_part "$SESSION_NAME")"
else
  PEER_ID="${tool.kind}-\$(tty_peer_part)"
fi

export HCC_PEER="$PEER_ID"
export HCC_ROOT

current_tmux_pane() {
  if [ -n "\${TMUX_PANE:-}" ]; then
    printf '%s\\n' "$TMUX_PANE"
    return 0
  fi
  TTY_PATH=$(tty 2>/dev/null || true)
  if [ -z "$TTY_PATH" ] || [ "$TTY_PATH" = "not a tty" ]; then
    return 1
  fi
  tmux list-panes -a -F '#{pane_id} #{pane_tty}' 2>/dev/null | awk -v tty="$TTY_PATH" '$2 == tty { print $1; found = 1; exit } END { exit found ? 0 : 1 }'
}

CURRENT_HCC_PANE=""
CURRENT_HCC_SESSION=""
detect_current_hcc_pane() {
  CURRENT_HCC_SESSION=""
  CURRENT_HCC_PANE=$(current_tmux_pane || true)
  if [ -z "$CURRENT_HCC_PANE" ]; then
    return 1
  fi
  CURRENT_HCC_SESSION=$(tmux display-message -p -t "$CURRENT_HCC_PANE" '#S' 2>/dev/null || true)
  case "$CURRENT_HCC_SESSION" in
    hcc-*-*) return 0 ;;
  esac
  CURRENT_HCC_PANE=""
  CURRENT_HCC_SESSION=""
  return 1
}

if detect_current_hcc_pane; then
  SESSION_PEER_ID=$(printf '%s' "$CURRENT_HCC_SESSION" | sed 's/^hcc-[^-]*-//')
  if [ -n "$SESSION_PEER_ID" ] && [ "$SESSION_PEER_ID" != "$CURRENT_HCC_SESSION" ]; then
    PEER_ID="$SESSION_PEER_ID"
  fi
  export HCC_PEER="$PEER_ID"
  "$HCC_BIN" web >/dev/null 2>&1 || true
  "$HCC_BIN" peer attach "$PEER_ID" --kind "${tool.kind}" --pane "$CURRENT_HCC_PANE" --cwd "$PWD" --force >/dev/null 2>&1 || true
  exec "$REAL_BIN" "$@"
fi

set +e
# Wrap in shell so pane_pid stays as bash; Ctrl+C drops back to bash
START_OUT=$("$HCC_BIN" web >/dev/null 2>&1 || true; "$HCC_BIN" peer start "$PEER_ID" --kind "${tool.kind}" --restart-env -- bash -lc 'REAL_BIN="$1"; shift; hcc_provider_state() { HCC_TMUX_SESSION=$(tmux display-message -p "#S" 2>/dev/null || true); if [ -n "$HCC_TMUX_SESSION" ]; then tmux set-environment -t "$HCC_TMUX_SESSION" HCC_PROVIDER_STATE "$1" >/dev/null 2>&1 || true; fi; }; hcc_provider_state running; "$REAL_BIN" "$@"; hcc_provider_state exited; exec bash' _ "$REAL_BIN" "$@" 2>&1)
START_STATUS=$?
set -e
if [ "$START_STATUS" -ne 0 ]; then
  printf '%s\\n' "$START_OUT" >&2
  exit "$START_STATUS"
fi

PANE=$(printf '%s\\n' "$START_OUT" | sed -n 's/.*pane=\\(%[0-9][0-9]*\\).*/\\1/p' | tail -n 1)
if [ -z "$PANE" ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

if [ "$HCC_SHIM_NO_ATTACH" = "1" ] || [ ! -t 0 ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

SESSION=$(tmux display-message -p -t "$PANE" '#S' 2>/dev/null || true)
if [ -z "$SESSION" ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

if [ -n "$TMUX" ]; then
  exec tmux switch-client -t "$SESSION"
fi

exec tmux attach-session -t "$SESSION"
`;
  }

  // Codex: resume/fork subcommand aware wrapper.
  return `#!/usr/bin/env bash
# hello-cc shim for ${tool.name} (auto-generated; do not edit manually)
# Wraps ${tool.name} with hello-cc peer mesh integration.
# Real binary: ${realBin}

set -e
REAL_BIN="${realBin}"
HCC_BIN="${hccBin}"

if [ "\${HCC_SHIM_ENSURED:-}" != "1" ]; then
  set +e
  "$HCC_BIN" shim ensure "${tool.name}" "$0" >/dev/null 2>&1
  ENSURE_STATUS=$?
  set -e
  if [ "$ENSURE_STATUS" = "75" ]; then
    export HCC_SHIM_ENSURED=1
    exec "$0" "$@"
  fi
fi

first_non_option() {
  EXPECT_VALUE=0
  for arg in "$@"; do
    if [ "$EXPECT_VALUE" = "1" ]; then
      EXPECT_VALUE=0
      continue
    fi

    case "$arg" in
      --)
        EXPECT_VALUE=0
        continue
        ;;
      -c|--config|-i|--image|-m|--model|-p|--profile|-s|--sandbox|-C|--cd|--add-dir|-a|--ask-for-approval|--remote|--remote-auth-token-env)
        EXPECT_VALUE=1
        continue
        ;;
      --config=*|--image=*|--model=*|--profile=*|--sandbox=*|--cd=*|--add-dir=*|--ask-for-approval=*|--remote=*|--remote-auth-token-env=*)
        continue
        ;;
      --*)
        continue
        ;;
      -*)
        continue
        ;;
      *)
        printf '%s' "$arg"
        return 0
        ;;
    esac
  done
  return 1
}

should_passthrough() {
  for arg in "$@"; do
    case "$arg" in
      -h|--help|-V|--version)
        return 0
        ;;
    esac
  done

  SUBCOMMAND=$(first_non_option "$@" || true)
  case "$SUBCOMMAND" in
    help|exec|e|review|login|logout|mcp|plugin|mcp-server|app-server|remote-control|completion|update|doctor|sandbox|debug|apply|a|archive|unarchive|cloud|exec-server|features)
      return 0
      ;;
  esac

  return 1
}

if should_passthrough "$@"; then
  exec "$REAL_BIN" "$@"
fi

HCC_ROOT=$("$HCC_BIN" find-root 2>/dev/null || true)

if [ -z "$HCC_ROOT" ]; then
  exec "$REAL_BIN" "$@"
fi

sanitize_peer_part() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g; s/^-*//; s/-*$//' | cut -c 1-32
}

tty_peer_part() {
  TTY_NUM=$(tty 2>/dev/null | tr -dc '0-9' | tail -c 4)
  PARENT_PID="\${PPID:-$$}"
  if [ -n "$TTY_NUM" ]; then
    printf '%s-%s' "$TTY_NUM" "$PARENT_PID"
  else
    printf '%s' "$PARENT_PID"
  fi
}

SUBCMD=""
RESUME_ID=""
EXPECT_SESSION=0
for arg in "$@"; do
  if [ -z "$SUBCMD" ]; then
    if [ "$arg" = "resume" ] || [ "$arg" = "fork" ]; then
      SUBCMD="$arg"
      EXPECT_SESSION=1
    fi
    continue
  fi
  if [ "$EXPECT_SESSION" = "1" ]; then
    case "$arg" in
      --last) EXPECT_SESSION=0 ;;
      -*) ;;
      *) RESUME_ID="$arg"; EXPECT_SESSION=0 ;;
    esac
  fi
done

if [ -n "$HCC_PEER" ]; then
  PEER_ID="$HCC_PEER"
elif [ "$SUBCMD" = "resume" ] && [ -n "$RESUME_ID" ]; then
  PEER_ID="${tool.kind}-\$(sanitize_peer_part "\${RESUME_ID:0:8}")"
else
  PEER_ID="${tool.kind}-\$(tty_peer_part)"
fi

export HCC_PEER="$PEER_ID"
export HCC_ROOT

current_tmux_pane() {
  if [ -n "\${TMUX_PANE:-}" ]; then
    printf '%s\\n' "$TMUX_PANE"
    return 0
  fi
  TTY_PATH=$(tty 2>/dev/null || true)
  if [ -z "$TTY_PATH" ] || [ "$TTY_PATH" = "not a tty" ]; then
    return 1
  fi
  tmux list-panes -a -F '#{pane_id} #{pane_tty}' 2>/dev/null | awk -v tty="$TTY_PATH" '$2 == tty { print $1; found = 1; exit } END { exit found ? 0 : 1 }'
}

CURRENT_HCC_PANE=""
CURRENT_HCC_SESSION=""
detect_current_hcc_pane() {
  CURRENT_HCC_SESSION=""
  CURRENT_HCC_PANE=$(current_tmux_pane || true)
  if [ -z "$CURRENT_HCC_PANE" ]; then
    return 1
  fi
  CURRENT_HCC_SESSION=$(tmux display-message -p -t "$CURRENT_HCC_PANE" '#S' 2>/dev/null || true)
  case "$CURRENT_HCC_SESSION" in
    hcc-*-*) return 0 ;;
  esac
  CURRENT_HCC_PANE=""
  CURRENT_HCC_SESSION=""
  return 1
}

if detect_current_hcc_pane; then
  SESSION_PEER_ID=$(printf '%s' "$CURRENT_HCC_SESSION" | sed 's/^hcc-[^-]*-//')
  if [ -n "$SESSION_PEER_ID" ] && [ "$SESSION_PEER_ID" != "$CURRENT_HCC_SESSION" ]; then
    PEER_ID="$SESSION_PEER_ID"
  fi
  export HCC_PEER="$PEER_ID"
  "$HCC_BIN" web >/dev/null 2>&1 || true
  "$HCC_BIN" peer attach "$PEER_ID" --kind "${tool.kind}" --pane "$CURRENT_HCC_PANE" --cwd "$PWD" --force >/dev/null 2>&1 || true
  exec "$REAL_BIN" "$@"
fi

set +e
# Wrap in shell so pane_pid stays as bash; Ctrl+C drops back to bash
START_OUT=$("$HCC_BIN" web >/dev/null 2>&1 || true; "$HCC_BIN" peer start "$PEER_ID" --kind "${tool.kind}" --restart-env -- bash -lc 'REAL_BIN="$1"; shift; hcc_provider_state() { HCC_TMUX_SESSION=$(tmux display-message -p "#S" 2>/dev/null || true); if [ -n "$HCC_TMUX_SESSION" ]; then tmux set-environment -t "$HCC_TMUX_SESSION" HCC_PROVIDER_STATE "$1" >/dev/null 2>&1 || true; fi; }; hcc_provider_state running; "$REAL_BIN" "$@"; hcc_provider_state exited; exec bash' _ "$REAL_BIN" "$@" 2>&1)
START_STATUS=$?
set -e
if [ "$START_STATUS" -ne 0 ]; then
  printf '%s\\n' "$START_OUT" >&2
  exit "$START_STATUS"
fi

PANE=$(printf '%s\\n' "$START_OUT" | sed -n 's/.*pane=\\(%[0-9][0-9]*\\).*/\\1/p' | tail -n 1)
if [ -z "$PANE" ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

if [ "$HCC_SHIM_NO_ATTACH" = "1" ] || [ ! -t 0 ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

SESSION=$(tmux display-message -p -t "$PANE" '#S' 2>/dev/null || true)
if [ -z "$SESSION" ]; then
  printf '%s\\n' "$START_OUT"
  exit 0
fi

if [ -n "$TMUX" ]; then
  exec tmux switch-client -t "$SESSION"
fi

exec tmux attach-session -t "$SESSION"
`;
}
