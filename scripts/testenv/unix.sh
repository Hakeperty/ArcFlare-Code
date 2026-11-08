#!/bin/sh
# ArcFlare install test, for a fresh Linux (WSL, container, VM) or macOS.
#
#   sh unix.sh prereq            as root: what a real user's machine already has
#                                (curl, certificates, tar, xz...) plus a normal
#                                user "tester" with passwordless sudo
#   sh unix.sh run [--desktop]   as that user: the one-line installs, then use them
#
# Every step prints one line, "STEP <name> ok|FAIL|skip <seconds>", to stdout
# and to $AF_TEST_OUT/steps.txt; full output goes to $AF_TEST_OUT/<name>.log.
#
#   AF_TEST_BASE           where install.sh / install-desktop.sh come from
#                          (default https://arcflare.net; a file:// dir works too)
#   ARCFLARE_INSTALL_FROM  passed to install.sh: what npm installs (default
#                          the GitHub main branch)
#   AF_TEST_OUT            results folder (default ./af-test-results)

MODE="${1:-run}"
DESKTOP=0
for a in "$@"; do [ "$a" = "--desktop" ] && DESKTOP=1; done

BASE="${AF_TEST_BASE:-https://arcflare.net}"
OUT="${AF_TEST_OUT:-$PWD/af-test-results}"
TEST_USER="${AF_TEST_USER:-tester}"
FAILED=0

mkdir -p "$OUT"
: > "$OUT/steps.txt"

now() { date +%s; }

# step <name> <command...>: run it, log it, print one STEP line.
step() {
  name="$1"; shift
  t0=$(now)
  if "$@" > "$OUT/$name.log" 2>&1; then res=ok; else res=FAIL; FAILED=$((FAILED + 1)); fi
  t1=$(now)
  line="STEP $name $res $((t1 - t0))"
  echo "$line" | tee -a "$OUT/steps.txt"
  if [ "$res" = FAIL ]; then sed 's/^/    | /' "$OUT/$name.log" | tail -n 25; fi
}

skip() { echo "STEP $1 skip 0" | tee -a "$OUT/steps.txt"; }

# Fetch a script from BASE (https:// or a local folder via file://).
get_script() { # get_script NAME DEST
  case "$BASE" in
    file://*) cp "${BASE#file://}/$1" "$2" ;;
    *) curl -fsSL "$BASE/$1" -o "$2" ;;
  esac
}

# --------------------------------------------------------------- prereq ----

prereq() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates tar xz-utils gzip unzip sudo procps libgomp1 >/dev/null
    [ "$DESKTOP" = 1 ] && apt-get install -y -qq xvfb xauth libfuse2t64 >/dev/null 2>&1 \
      || { [ "$DESKTOP" = 1 ] && apt-get install -y -qq xvfb xauth libfuse2 >/dev/null; }
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed curl ca-certificates tar xz gzip unzip sudo procps-ng gcc-libs >/dev/null
    [ "$DESKTOP" = 1 ] && pacman -S --noconfirm --needed xorg-server-xvfb xorg-xauth fuse2 >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl ca-certificates tar xz gzip unzip sudo procps-ng libgomp shadow-utils findutils >/dev/null
    [ "$DESKTOP" = 1 ] && dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth fuse-libs >/dev/null
  elif command -v zypper >/dev/null 2>&1; then
    zypper -n -q install curl ca-certificates tar xz gzip unzip sudo procps libgomp1 shadow findutils >/dev/null
    [ "$DESKTOP" = 1 ] && zypper -n -q install xvfb-run xauth libfuse2 >/dev/null
  elif command -v apk >/dev/null 2>&1; then
    apk add -q curl ca-certificates tar xz gzip unzip sudo procps shadow bash
  fi
  if ! id "$TEST_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$TEST_USER" 2>/dev/null || adduser -D -s /bin/sh "$TEST_USER"
  fi
  mkdir -p /etc/sudoers.d
  echo "$TEST_USER ALL=(ALL) NOPASSWD: ALL" > "/etc/sudoers.d/90-$TEST_USER"
  chmod 440 "/etc/sudoers.d/90-$TEST_USER"
}

# ------------------------------------------------------------------ cli ----

install_cli() {
  get_script install.sh "$OUT/install.sh"
  sh "$OUT/install.sh"
}

# The installer adds these to the shell profile; a test runs in one shell.
use_path() {
  PATH="$HOME/.arcflare/node/bin:$HOME/.arcflare/npm-global/bin:$HOME/.local/bin:$PATH"
  export PATH
}

cli_version() { arcflare --version; }
engine_install() {
  if [ "$(uname -s)" = Darwin ]; then arcflare engine install; else arcflare engine install --cpu; fi
}
pull_model() { arcflare pull ggml-org/tiny-llamas:Q8_0; }
ls_model() { arcflare ls | tee /dev/stderr | grep -qi stories; }
doctor() { arcflare doctor; }

# Load the pulled model in the installed engine and ask for a few tokens.
generate() {
  server=$(node -p 'require(require("os").homedir()+"/.arcflare/config.json").llamaServer' 2>/dev/null)
  [ -x "$server" ] || { echo "no engine in config.json (got: $server)"; return 1; }
  cache="${LLAMA_CACHE:-}"
  if [ -z "$cache" ]; then
    if [ "$(uname -s)" = Darwin ]; then cache="$HOME/Library/Caches/llama.cpp"; else cache="${XDG_CACHE_HOME:-$HOME/.cache}/llama.cpp"; fi
  fi
  model=$(find "$cache" -name '*.gguf' 2>/dev/null | head -n 1)
  [ -n "$model" ] || { echo "no .gguf under $cache"; return 1; }
  echo "server $server"
  echo "model  $model"
  "$server" -m "$model" --port 18089 -c 256 -ngl 0 > "$OUT/llama-server.log" 2>&1 &
  pid=$!
  i=0
  until curl -fs http://127.0.0.1:18089/health >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 90 ] || ! kill -0 "$pid" 2>/dev/null; then
      echo "server never became healthy"; tail -n 20 "$OUT/llama-server.log"; kill "$pid" 2>/dev/null; return 1
    fi
    sleep 1
  done
  reply=$(curl -fs http://127.0.0.1:18089/completion -H 'Content-Type: application/json' \
    -d '{"prompt":"Once upon a time","n_predict":12}')
  kill "$pid" 2>/dev/null
  echo "$reply"
  text=$(printf '%s' "$reply" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).content||"")}catch{}})')
  [ -n "$text" ] || { echo "empty completion"; return 1; }
  echo "generated: $text"
}

# -------------------------------------------------------------- desktop ----

install_desktop() {
  get_script install-desktop.sh "$OUT/install-desktop.sh"
  sh "$OUT/install-desktop.sh"
}

launch_desktop() {
  if [ "$(uname -s)" = Darwin ]; then
    app=/Applications/ArcFlare.app
    [ -d "$app" ] || app="$HOME/Applications/ArcFlare.app"
    open "$app" || return 1
    sleep 15
    pgrep -x ArcFlare >/dev/null || { echo "ArcFlare is not running after 15 s"; return 1; }
    echo "running: $app"
    pkill -x ArcFlare || true
    return 0
  fi
  bin=$(command -v arcflare-desktop 2>/dev/null || true)
  [ -n "$bin" ] || bin=$(ls /opt/ArcFlare/arcflare-desktop "$HOME/.local/share/arcflare-desktop/ArcFlare.AppImage" 2>/dev/null | head -n 1)
  [ -n "$bin" ] || { echo "no arcflare-desktop binary found"; return 1; }
  echo "binary: $bin"
  extra="--no-sandbox --disable-gpu"
  case "$bin" in *.AppImage) export APPIMAGE_EXTRACT_AND_RUN=1 ;; esac
  # ARCFLARE_HOME keeps the app's first run out of the real ~/.arcflare.
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    ARCFLARE_HOME="$OUT/app-home" "$bin" $extra > "$OUT/desktop-app.log" 2>&1 &
  else
    command -v xvfb-run >/dev/null 2>&1 || { echo "no display and no xvfb-run"; return 1; }
    ARCFLARE_HOME="$OUT/app-home" xvfb-run -a "$bin" $extra > "$OUT/desktop-app.log" 2>&1 &
  fi
  pid=$!
  sleep 20
  if ! kill -0 "$pid" 2>/dev/null; then echo "the app exited within 20 s"; tail -n 30 "$OUT/desktop-app.log"; return 1; fi
  echo "still running after 20 s"
  tail -n 10 "$OUT/desktop-app.log"
  pkill -f arcflare-desktop 2>/dev/null; pkill -f ArcFlare.AppImage 2>/dev/null; kill "$pid" 2>/dev/null
  return 0
}

# ----------------------------------------------------------------- main ----

case "$MODE" in
  prereq)
    step prereq prereq
    ;;
  run)
    echo "ArcFlare install test · $(uname -sm) · $(grep -m1 '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"')"
    step install-cli install_cli
    use_path
    step cli-version cli_version
    step engine-install engine_install
    step pull-model pull_model
    step ls-model ls_model
    step generate generate
    step doctor doctor
    if [ "$DESKTOP" = 1 ]; then
      step install-desktop install_desktop
      step launch-desktop launch_desktop
    fi
    ;;
  *)
    echo "usage: sh unix.sh prereq [--desktop] | run [--desktop]"; exit 2 ;;
esac

echo "DONE $FAILED failed"
[ "$FAILED" -eq 0 ]
