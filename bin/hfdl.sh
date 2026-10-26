#!/bin/bash
# ===============================================================================
# HFDL (HUGGING FACE DOWNLOADER) LAUNCHER
# ===============================================================================
# Runs bin/hfdl/hfdl.mjs from the project root, so the script's cwd-relative
# paths (conf/, hf cache, log files) resolve correctly no matter where this is
# invoked from.
#
# Usage:
#   bin/hfdl.sh [hfdl options]
# ===============================================================================

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." || exit 1
exec node bin/hfdl/hfdl.mjs "$@"
