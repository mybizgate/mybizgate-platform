#!/usr/bin/env bash
set -euo pipefail
# The workspace root .env is loaded automatically by src/cli.mjs (shell exports take precedence).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/../src/cli.mjs" rollback "$@"
