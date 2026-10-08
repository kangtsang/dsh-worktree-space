#!/usr/bin/env bash
#
# Bring up a DSH web instance with this plugin installed, and print the url to open.
#
# Three things happen in order, and each is skipped when the volume already holds its
# result, so a restarted container comes back in seconds:
#
#   1. a profile is seeded from the shipped `web` template. That template is written by
#      booting the profile once, which is why this is a start-up step and not a build one.
#   2. the plugin tarball is installed into that profile with `dsh plugin add`, which is
#      what puts it in `dsh.profile.bundles`. `pnpm add` alone lands the package in
#      node_modules and writes nothing there, so the profile boots without the plugin and
#      every case below then looks like a broken feature rather than a missing install.
#   3. the source root the cases work on is created: two real git repositories, because a
#      task space is made of git worktrees and there is nothing to accept without them.
#
# The last `URL=` line is the one to hand to the reader. The host in it is rewritten to
# `localhost` because that is what reaches the published port from outside; the token that
# follows is left exactly as DSH printed it.
set -euo pipefail

: "${DSH_BIN:?DSH_BIN is not set}"
: "${DSH_HOME:?DSH_HOME is not set}"
PORT="${PORT:-34822}"
PROFILE=accept
PLUGIN_TGZ=/tmp/plugin.tgz
SOURCE_ROOT=/workspace/source
ENV_FILE=/dsh/acceptance.env
BOOT_LOG=/dsh/boot.log

mkdir -p "$DSH_HOME" "$SOURCE_ROOT"

# The bind host goes through the profile's patch layer, not through `--host`.
#
# DSH 0.2.0-rc.2's web app refuses `--host 0.0.0.0` at the flag: "intentionally not
# supported yet for safety: it would expose remote code execution to the network; use
# 127.0.0.1 instead" (dsh-web-app/lib/startup.js). A published container port, however,
# only reaches a listener on every interface; a loopback-only listener inside the
# container is unreachable through `-p`. The `webserver` row's own config schema accepts
# exactly `127.0.0.1` or `0.0.0.0` (dsh-host-webserver), so the host is set there via
# `--patch`. That row's config is replaced wholesale rather than deep-merged, so the port
# has to be repeated here or the row fails validation for a missing `port`.
HOST_PATCH="$DSH_HOME/acceptance-host.yml"
printf '%s\n' \
  '- id: webserver' \
  '  config:' \
  '    host: 0.0.0.0' \
  "    port: $PORT" \
  >"$HOST_PATCH"

# Wait for a predicate, up to a limit. Counted in seconds of its own, never compared
# against a wall clock: the install below takes as long as the network takes.
wait_for() {
  local limit="$1"; shift
  local i
  for ((i = 0; i < limit; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# Wait for the url, and give up the moment the server does.
#
# A wait that only counts seconds sits there for its whole length after the process has
# already died, which is how a boot that failed on its own first line came to look like a
# slow one: five minutes of "still starting" over a server that had printed an error and
# exited.
wait_for_url() {
  local pid="$1" limit="$2" i
  for ((i = 0; i < limit; i++)); do
    if grep -qE 'https?://' "$BOOT_LOG" 2>/dev/null; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then return 1; fi
    sleep 1
  done
  return 1
}

if [ ! -f "$DSH_HOME/profiles/$PROFILE/package.json" ]; then
  echo "[accept] seeding profile '$PROFILE' from the shipped web template"
  node "$DSH_BIN" --profile "$PROFILE" --from-default-profile web --host 127.0.0.1 --no-open --port "$PORT" >"$BOOT_LOG" 2>&1 &
  seed=$!
  if ! wait_for 300 test -f "$DSH_HOME/profiles/$PROFILE/package.json"; then
    echo "[accept] FAILED: the profile was never seeded. Log follows."
    cat "$BOOT_LOG"
    exit 1
  fi
  kill "$seed" 2>/dev/null || true
  wait "$seed" 2>/dev/null || true
  : >"$BOOT_LOG"
fi

if [ ! -d "$DSH_HOME/profiles/$PROFILE/node_modules/dsh-worktree-space" ]; then
  echo "[accept] installing the plugin into the profile"
  node "$DSH_BIN" plugin --profile "$PROFILE" add "$PLUGIN_TGZ"
fi

BUNDLES="$(node -e "const p=require('$DSH_HOME/profiles/$PROFILE/package.json');process.stdout.write((p.dsh?.profile?.bundles??[]).join(','))")"
case ",$BUNDLES," in
  *,dsh-worktree-space,*) echo "[accept] profile bundles: $BUNDLES" ;;
  *) echo "[accept] FAILED: the profile does not list the plugin in bundles: $BUNDLES"; exit 1 ;;
esac

echo "[accept] preparing the source root at $SOURCE_ROOT"
for name in repo-a repo-b; do
  repo="$SOURCE_ROOT/$name"
  if [ ! -d "$repo/.git" ]; then
    mkdir -p "$repo"
    git -C "$repo" init -q -b main
    git -C "$repo" config user.email acceptance@example.invalid
    git -C "$repo" config user.name acceptance
    printf '# %s\n\nA seed repository for the acceptance cases.\n' "$name" >"$repo/README.md"
    git -C "$repo" add -A
    git -C "$repo" commit -qm "seed $name"
  fi
done

echo "[accept] booting the web profile on port $PORT"
node "$DSH_BIN" --profile "$PROFILE" --patch "$HOST_PATCH" --no-open --port "$PORT" \
  --trusted-host "localhost:$PORT" --trusted-host "127.0.0.1:$PORT" >"$BOOT_LOG" 2>&1 &
serve=$!

if ! wait_for_url "$serve" 300; then
  echo "[accept] FAILED: no url was printed. Log follows."
  cat "$BOOT_LOG"
  exit 1
fi

RAW="$(grep -oE 'https?://[^[:space:]]+' "$BOOT_LOG" | head -1)"
URL="$(printf '%s' "$RAW" | sed -E "s#^(https?://)[^/]+#\1localhost:$PORT#")"
{
  echo "URL=$URL"
  echo "URL_AS_PRINTED=$RAW"
  echo "PORT=$PORT"
  echo "PROFILE=$PROFILE"
  echo "DSH_VERSION=$DSH_VERSION"
  echo "DSH_HOME=$DSH_HOME"
  echo "SOURCE_ROOT=$SOURCE_ROOT"
  echo "TASK_CONTAINER_ROOT=/workspace/worktree-space"
  echo "WORKSPACE_JSON=$DSH_HOME/storages/workspace.json"
} | tee "$ENV_FILE"

wait "$serve"
