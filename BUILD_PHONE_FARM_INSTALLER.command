#!/bin/zsh
# DEVELOPER TOOL - NOT THE PHONE FARM INSTALLER.
# Builds the installer from a source checkout. Ordinary users download the
# finished Phone-Farm-<version>-arm64.pkg from GitHub Releases instead.

case "$0" in
  */*) SCRIPT_PATH_DIR="${0%/*}" ;;
  *) SCRIPT_PATH_DIR="." ;;
esac
SCRIPT_DIR="$(cd -- "$SCRIPT_PATH_DIR" && pwd)"

echo "DEVELOPER TOOL - NOT THE PHONE FARM INSTALLER"
echo "(users: download the ready-made .pkg from GitHub Releases and double-click it)"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "This developer builder needs Node.js 20 or newer. Install Node.js, then run this file again."
  STATUS=1
else
  node "$SCRIPT_DIR/BUILD_PHONE_FARM_INSTALLER.mjs" "$@"
  STATUS=$?
fi

if [[ -t 0 ]]; then
  echo
  read -r "REPLY?Press Return to close..."
fi

exit $STATUS
