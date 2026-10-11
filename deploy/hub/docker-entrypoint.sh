#!/bin/sh
# Creates the empty config files a fresh hub needs, then starts it. The hub keeps no
# phones of its own (they live at sites), so its device list starts empty; operators
# are added with create-operator.js (see docs/DEPLOY_HUB.md).
set -eu

CONFIG_DIR=/app/system/storage/config

# Railway volumes are mounted root-owned after the image is built. Initialize
# their ownership at runtime, then run the application without root privileges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$CONFIG_DIR"
else
  mkdir -p "$CONFIG_DIR"
fi
[ -f "$OPERATORS_CONFIG_PATH" ] || echo '{"operators":[]}' > "$OPERATORS_CONFIG_PATH"
[ -f "$DEVICE_CONFIG_PATH" ] || echo '{"devices":[]}' > "$DEVICE_CONFIG_PATH"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/system/storage
  exec su-exec node:node "$@"
fi

exec "$@"
