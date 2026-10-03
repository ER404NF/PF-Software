#!/bin/bash
# DEVELOPER TOOL - builds a macOS installer (.pkg) from this source checkout.
#
# This is NOT how people install Phone Farm. They double-click "Install Phone Farm.command" at the
# repository root, which downloads the published, checksummed release. Use this only to test a
# change before it is released.
#
#   desktop/scripts/build-macos-installer.sh [arm64|universal] [--skip-tests]
#
# Needs a Mac with Node.js 20+. The package is UNSIGNED (and named -UNSIGNED) unless Developer ID
# identities and notarization credentials are available - see docs/MAC_RELEASE.md. Output goes to
# desktop/dist/, which git ignores.
set -euo pipefail

arch="arm64"
run_tests=1
for arg in "$@"; do
  case "$arg" in
    arm64|universal) arch="$arg" ;;
    --skip-tests) run_tests=0 ;;
    *) echo "usage: $0 [arm64|universal] [--skip-tests]" >&2; exit 2 ;;
  esac
done

desktop_dir="$(cd "$(dirname "$0")/.." && pwd)"
system_dir="$(cd "$desktop_dir/../system" && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "The macOS installer can only be built on macOS (use the GitHub 'macOS installer' workflow otherwise)." >&2
  exit 1
fi
if ! command -v node > /dev/null 2>&1 || ! command -v npm > /dev/null 2>&1; then
  echo "Node.js 20 or newer (with npm) is required: https://nodejs.org" >&2
  exit 1
fi

echo "== Installing dependencies from the lockfiles"
(cd "$system_dir" && npm ci)
(cd "$desktop_dir" && npm ci && node scripts/ensure-electron.cjs)

if [ "$run_tests" = "1" ]; then
  echo "== Running the server and desktop test suites"
  (cd "$system_dir" && npm test)
  (cd "$desktop_dir" && npm test)
fi

echo "== Building the $arch installer"
(cd "$desktop_dir" && node scripts/build-mac-pkg.cjs --arch "$arch")

version="$(node -p "require('$desktop_dir/package.json').version")"
echo
for pkg in "$desktop_dir"/dist/Phone-Farm-"$version"-"$arch"*.pkg; do
  [ -s "$pkg" ] || continue
  (cd "$(dirname "$pkg")" && shasum -a 256 "$(basename "$pkg")" | tee "$(basename "$pkg").sha256")
  echo "Built: $pkg"
done
