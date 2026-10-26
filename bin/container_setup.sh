#!/bin/bash
# ===============================================================================
# CONTAINER SETUP LAUNCHER
# ===============================================================================
# Runs bin/container_setup/container_setup.mjs from the project root, so the
# script's cwd-relative paths (conf/, model_compose_overrides/, log files)
# resolve correctly no matter where this is invoked from.
#
# Usage:
#   bin/container_setup.sh --models-conf conf/test.json --model "Qwen/Qwen3-0.6B"
# ===============================================================================

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." || exit 1
exec node bin/container_setup/container_setup.mjs "$@"
