#!/usr/bin/env bash
# check-versions.sh — Verify package.json and toolkit.json have the same version.
# Exits 1 if they differ so CI fails fast.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PKG_VERSION=$(node -p "require('$ROOT/package.json').version")
TOOLKIT_VERSION=$(node -p "require('$ROOT/toolkit.json').version")

if [[ "$PKG_VERSION" != "$TOOLKIT_VERSION" ]]; then
  echo "Version mismatch:" >&2
  echo "  package.json:  $PKG_VERSION" >&2
  echo "  toolkit.json:  $TOOLKIT_VERSION" >&2
  exit 1
fi

echo "Versions in sync: $PKG_VERSION"
