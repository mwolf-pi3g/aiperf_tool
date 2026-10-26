#!/bin/bash
# ===============================================================================
# AIPERF & HFDL ENVIRONMENT INITIALIZATION SCRIPT
# ===============================================================================
# Usage:
#   source bin/init.sh
#   or: . bin/init.sh
# ===============================================================================

# Determine project directory paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"
VENV_DIR="${PROJECT_ROOT}/venv"

echo "========================================================================="
echo "        INITIALIZING AIPERF BENCHMARKING ENVIRONMENT                     "
echo "========================================================================="

# -------------------------------------------------------------------------------
# 1. Chromium Browser Installation & Environment Variables
# -------------------------------------------------------------------------------
# Install Chromium browser if missing (required for aiperf plotting/reporting)
if ! command -v chromium &>/dev/null && ! command -v chromium-browser &>/dev/null && [ ! -f "/snap/chromium/current/usr/lib/chromium-browser/chrome" ]; then
    echo "[INIT] Chromium browser not found. Installing chromium-browser..."
    sudo apt update && sudo apt install -y chromium-browser
else
    echo "[INIT] Chromium browser is installed."
fi

# Locate Chromium binary and set environment paths required by aiperf.
# Resolve "current" to the actual snap revision: choreographer takes BROWSER_PATH
# as a total override (utils/_which.py) with no validation, so an unresolved path
# is accepted here and only fails later at render time. The PATH-based chromium
# entries are wrapper scripts, not browser binaries, so there is no fallback.
export BROWSER_PATH="$(readlink -f /snap/chromium/current)/usr/lib/chromium-browser/chrome"
export CHOREO_CHROME_PATH="$BROWSER_PATH"
echo "[INIT] Exported BROWSER_PATH=${BROWSER_PATH}"
echo "[INIT] Exported CHOREO_CHROME_PATH=${CHOREO_CHROME_PATH}"

# -------------------------------------------------------------------------------
# 2. Python Virtual Environment (venv) Creation & Activation
# -------------------------------------------------------------------------------
if [ ! -d "$VENV_DIR" ]; then
    echo "[INIT] Virtual environment not found at ${VENV_DIR}. Creating Python venv..."
    if ! python3 -m venv "$VENV_DIR" 2>/dev/null; then
        echo "[INIT] Failed to create venv. Installing python3-venv and python3-dev..."
        sudo apt update && sudo apt install -y python3-venv python3-dev
        python3 -m venv "$VENV_DIR"
    fi
fi

if [ -f "${VENV_DIR}/bin/activate" ]; then
    echo "[INIT] Activating virtual environment (${VENV_DIR})..."
    source "${VENV_DIR}/bin/activate"
else
    echo "[ERROR] Could not locate activate script at ${VENV_DIR}/bin/activate"
fi

# -------------------------------------------------------------------------------
# 3. AIPerf Package Installation & Verification
# -------------------------------------------------------------------------------
if command -v pip &>/dev/null; then
    echo "[INIT] Upgrading pip..."
    pip install --upgrade pip --quiet
fi

if ! command -v aiperf &>/dev/null; then
    echo "[INIT] 'aiperf' CLI tool not found in virtual environment. Installing aiperf..."
    if ! pip install aiperf; then
        echo "[INIT] AIPerf installation failed. Installing python3-dev build header dependencies..."
        sudo apt update && sudo apt install -y python3-dev python3.12-dev 2>/dev/null || true
        pip install aiperf
    fi
else
    echo "[INIT] 'aiperf' CLI is installed: $(which aiperf)"
fi

# -------------------------------------------------------------------------------
# 4. Tmux 4-Command Primer
# -------------------------------------------------------------------------------
echo ""
echo "-------------------------------------------------------------------------"
echo "        TMUX 4-COMMAND PRIMER                                            "
echo "-------------------------------------------------------------------------"
echo "  1. Start new session  : tmux (or tmux new -s session_name)"
echo "  2. List sessions      : tmux ls"
echo "  3. Attach to session  : tmux a (or tmux attach -t session_name)"
echo "  4. Detach / Kill      : Ctrl+B d (to detach) | tmux kill-session -t session_name"
echo "-------------------------------------------------------------------------"

echo "========================================================================="
echo "        ENVIRONMENT INITIALIZATION COMPLETE                              "
echo "========================================================================="


