#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# startup.sh  –  Sets up virtual display (Xvfb) + noVNC browser view, then
#               starts the Playwright Trainer Node.js server.
#
# This script is invoked by devcontainer.json "postStartCommand".
# ─────────────────────────────────────────────────────────────────────────────
set -e

DISPLAY_NUM=99
DISPLAY=":${DISPLAY_NUM}"
export DISPLAY

SCREEN_WIDTH=1920
SCREEN_HEIGHT=1080
SCREEN_DEPTH=24

echo "======================================================"
echo "  🎭  Playwright Trainer – Environment Setup"
echo "======================================================"

# ── 1. Install system packages if missing ─────────────────────────────────────
need_pkg() { ! dpkg -s "$1" &>/dev/null; }

PKGS_NEEDED=()
for pkg in xvfb x11vnc websockify novnc fluxbox; do
  need_pkg "$pkg" && PKGS_NEEDED+=("$pkg")
done

if [ ${#PKGS_NEEDED[@]} -gt 0 ]; then
  echo "Installing: ${PKGS_NEEDED[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends "${PKGS_NEEDED[@]}" 2>/dev/null || true
fi

# ── 2. Start Xvfb (virtual framebuffer) ──────────────────────────────────────
if ! pgrep -x Xvfb > /dev/null; then
  echo "Starting Xvfb on display ${DISPLAY}..."
  Xvfb "${DISPLAY}" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" -nolisten tcp &
  sleep 1
else
  echo "Xvfb already running on ${DISPLAY}"
fi

# Start a minimal window manager so windows are usable in VNC
if command -v fluxbox &>/dev/null && ! pgrep -x fluxbox > /dev/null; then
  DISPLAY="${DISPLAY}" fluxbox &>/dev/null &
fi

# ── 3. Start x11vnc (VNC server on Xvfb display) ─────────────────────────────
if ! pgrep -x x11vnc > /dev/null; then
  echo "Starting x11vnc..."
  x11vnc -display "${DISPLAY}" -forever -nopw -quiet -rfbport 5900 \
         -clip "${SCREEN_WIDTH}x${SCREEN_HEIGHT}+0+0" &
  sleep 1
else
  echo "x11vnc already running"
fi

# ── 4. Start noVNC WebSocket proxy (port 6080 → VNC 5900) ────────────────────
if ! pgrep -f "websockify.*6080" > /dev/null; then
  NOVNC_DIR=""
  for candidate in /usr/share/novnc /usr/local/share/novnc /opt/novnc; do
    [ -d "$candidate" ] && NOVNC_DIR="$candidate" && break
  done

  if [ -n "$NOVNC_DIR" ]; then
    echo "Starting noVNC on port 6080 (web dir: ${NOVNC_DIR})..."
    websockify --web "${NOVNC_DIR}" 6080 localhost:5900 &>/dev/null &
    sleep 1
    echo "  → Browser view available at http://localhost:6080/vnc.html"
  else
    echo "  ⚠  noVNC web assets not found – skipping noVNC startup."
    echo "     Install novnc package or use: DISPLAY=${DISPLAY} xterm &"
  fi
else
  echo "noVNC/websockify already running"
fi

# ── 5. Start the Playwright Trainer server ────────────────────────────────────
# kill any previous instance to avoid EADDRINUSE
if pgrep -f "node server.js" >/dev/null; then
  echo "Stopping existing Playwright Trainer server..."
  pkill -f "node server.js" || true
  sleep 1
fi

echo ""
echo "Starting Playwright Trainer server on port 3000 (background)..."
echo ""
# compute script directory reliably even if caller's cwd is different
# (BASH_SOURCE may be empty when called via `bash file`, so fall back to $0)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# workspace root is one level above the .devcontainer folder
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${WORKSPACE_ROOT}" || exit 1
# launch in background so startup script can exit cleanly
DISPLAY="${DISPLAY}" nohup node server.js >/dev/null 2>&1 &

# write a handy reminder command to a text file in the workspace root
# path uses SCRIPT_DIR to stay correct
echo "bash \\$PWD/.devcontainer/startup.sh" > "${SCRIPT_DIR}/../START_SERVER.txt"
