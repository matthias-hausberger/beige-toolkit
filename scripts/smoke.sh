#!/usr/bin/env bash
# smoke.sh — Run a full smoke sequence: typecheck + tests.
#
# Usage:
#   bash scripts/smoke.sh
#   pnpm smoke

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT"

echo "[smoke] Checking versions are in sync..."
pnpm check-versions

echo "[smoke] Typechecking..."
pnpm typecheck

echo "[smoke] Running tests..."
pnpm test

echo "[smoke] All checks passed ✓"
