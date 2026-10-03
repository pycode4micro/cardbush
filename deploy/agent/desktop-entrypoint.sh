#!/bin/bash
set -euo pipefail
umask 077
size="${CARDBUSH_DESKTOP_SIZE:-1600x900}"
if [[ ! "$size" =~ ^([0-9]{3,4})x([0-9]{3,4})$ ]]; then
  echo 'Invalid CARDBUSH_DESKTOP_SIZE.' >&2; exit 1
fi
width="${BASH_REMATCH[1]}"; height="${BASH_REMATCH[2]}"
if ((10#$width < 800 || 10#$width > 4096 || 10#$height < 600 || 10#$height > 2160)); then
  echo 'Desktop dimensions must be within 800x600 and 4096x2160.' >&2; exit 1
fi
export XAUTHORITY="/tmp/cardbush-xauthority"
touch "$XAUTHORITY"
xauth -f "$XAUTHORITY" add "$DISPLAY" MIT-MAGIC-COOKIE-1 "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
pids=()
cleanup() {
  trap - EXIT TERM INT
  if ((${#pids[@]})); then kill "${pids[@]}" 2>/dev/null || true; fi
  wait || true
}
trap cleanup EXIT
trap 'exit 143' TERM INT
Xvfb "$DISPLAY" -screen 0 "${size}x24" -dpi 96 -nolisten tcp -auth "$XAUTHORITY" & pids+=("$!")
ready=0
for _ in {1..100}; do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.1
done
if ((ready == 0)); then echo 'Virtual desktop startup failed.' >&2; exit 1; fi
export DBUS_SESSION_BUS_ADDRESS
DBUS_SESSION_BUS_ADDRESS="$(dbus-daemon --session --fork --print-address)"
openbox & pids+=("$!")
tint2 & pids+=("$!")
node dist-electron/agentServiceCli.mjs --desktop "$@" & pids+=("$!")
# Any supervised component exiting stops this dedicated container; Docker owns recovery.
wait -n "${pids[@]}"
exit 1
