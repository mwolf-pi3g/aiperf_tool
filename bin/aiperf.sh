#!/bin/bash
# ===============================================================================
# AIPERF ORCHESTRATOR LAUNCHER
# ===============================================================================
# Runs bin/aiperf/aiperf_orchestrator.mjs from the project root, so the
# script's cwd-relative paths (conf/, artifacts, log files) resolve correctly
# no matter where this is invoked from.
#
# Usage:
#   bin/aiperf.sh [orchestrator options]
# ===============================================================================

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." || exit 1
exec node bin/aiperf/aiperf_orchestrator.mjs "$@"
