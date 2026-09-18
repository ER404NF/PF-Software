#!/bin/zsh

case "$0" in
  */*) SCRIPT_PATH_DIR="${0%/*}" ;;
  *) SCRIPT_PATH_DIR="." ;;
esac
SCRIPT_DIR="$(cd -- "$SCRIPT_PATH_DIR" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Phone Farm local installer builder needs Node.js 20 or newer. Install Node.js, then run this file again."
  STATUS=1
else
  node "$SCRIPT_DIR/DOWNLOAD_PHONE_FARM.mjs" "$@"
  STATUS=$?
fi

if [[ -t 0 ]]; then
  echo
  read -r "REPLY?Press Return to close..."
fi

exit $STATUS
