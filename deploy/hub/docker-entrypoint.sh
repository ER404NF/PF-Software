#!/bin/sh
# Creates the empty config files a fresh hub needs, then starts it. The hub keeps no
# phones of its own (they live at sites), so its device list starts empty; operators
# are added with create-operator.js (see docs/DEPLOY_HUB.md).
set -eu

CONFIG_DIR=/app/system/storage/config
mkdir -p "$CONFIG_DIR"
[ -f "$OPERATORS_CONFIG_PATH" ] || echo '{"operators":[]}' > "$OPERATORS_CONFIG_PATH"
[ -f "$DEVICE_CONFIG_PATH" ] || echo '{"devices":[]}' > "$DEVICE_CONFIG_PATH"

exec "$@"
