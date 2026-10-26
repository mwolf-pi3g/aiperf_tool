#!/bin/bash
# ===============================================================================
# NODE.JS & NVM SETUP SCRIPT
# ===============================================================================
# Installs Node Version Manager (NVM) and sets default Node.js version to v24.14.1
#
# Usage:
#   bash bin/setup/node.sh
#   or: source bin/setup/node.sh
# ===============================================================================

set -e

NODE_VERSION="v24.14.1"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

echo "========================================================================="
echo "        INSTALLING NVM & SETTING DEFAULT NODE VERSION (${NODE_VERSION})  "
echo "========================================================================="

# 1. Install NVM if not already installed
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "[INFO] NVM not found. Installing NVM..."
    if command -v curl &>/dev/null; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    elif command -v wget &>/dev/null; then
        wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    else
        echo "[ERROR] Neither curl nor wget is available. Please install curl or wget first."
        exit 1
    fi
else
    echo "[INFO] NVM is already installed at ${NVM_DIR}."
fi

# 2. Load NVM into current shell session
export NVM_DIR="$NVM_DIR"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    \. "$NVM_DIR/nvm.sh"
else
    echo "[ERROR] Failed to load NVM script from $NVM_DIR/nvm.sh"
    exit 1
fi

if [ -s "$NVM_DIR/bash_completion" ]; then
    \. "$NVM_DIR/bash_completion"
fi

# 3. Install Node version v24.14.1
echo "[INFO] Installing Node.js ${NODE_VERSION}..."
nvm install "$NODE_VERSION"

# 4. Set default version to v24.14.1 and use it
echo "[INFO] Setting default Node.js version to ${NODE_VERSION}..."
nvm alias default "$NODE_VERSION"
nvm use "$NODE_VERSION"

echo "========================================================================="
echo "        NODE.JS SETUP COMPLETE                                           "
echo "        Active Node version: $(node -v 2>/dev/null || echo 'Unknown')"
echo "        Default Node alias : $(nvm version default 2>/dev/null || echo 'Unknown')"
echo "========================================================================="
