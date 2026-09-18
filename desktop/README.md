# Phone Farm desktop host

The Electron app has two isolated window types:

- the packaged local first-run window receives `preload.js` and can invoke the
  narrowly scoped host-setup IPC handlers;
- the Phone Farm web window receives no preload, even in client mode, and is
  restricted to the configured HTTP(S) origin.

On macOS, host startup resolves Xcode, libimobiledevice, iproxy, and
WebDriverAgent before spawning the server with Electron's bundled Node runtime.
It searches both Apple Silicon and Intel Homebrew paths and does not depend on
Finder inheriting Terminal's `PATH`. A fresh install does not need a manual
`devices.config.json`.

## Build and test

```sh
cd desktop
npm ci
npm test
npm run dist:mac
```

`dist:mac` first runs `npm ci --omit=dev` in `../system`, verifies the server
entry point, web client, and production modules, then packages that complete
runtime under the app's `Contents/Resources/system` directory. The output is
written to `desktop/dist/`.

The root `DOWNLOAD_PHONE_FARM.command` is retained for compatibility, but it is
a developer/local installer builder rather than an end-user downloader. A
normal operator should receive the generated DMG and should not need Node.js or
Terminal after installation.

## Automatic and explicit settings

The desktop host automatically supplies:

- `AUTO_PROVISION_WDA=true`
- `AUTO_DISCOVER_IOS_DEVICES=true`
- `DESKTOP_AUTO_DEVICE_MODE=true` so the repository's example device file is
  ignored unless an advanced explicit `DEVICE_CONFIG_PATH` is supplied
- resolved `WDA_REPO_PATH`, `IPROXY_BIN`, `IDEVICE_ID_BIN`,
  `IDEVICEINFO_BIN`, `XCODEBUILD_BIN`, and `XCODE_SELECT_BIN`
- a Finder-safe `PATH`
- per-user runtime storage and WDA derived-data paths

`AUTO_ROUTE_PROXY_TUNNELS`, `AUTO_NETWORK_ENROLLMENT`, and
`AUTO_ENABLE_INTERNET_SHARING` are not enabled by desktop startup. If routing
is explicitly enabled, the resolver accepts either `tun2proxy` or
`tun2proxy-bin` and supplies `TUN2PROXY_BIN`.

Real Mac, WDA signing, trusted-device, Developer Mode, and two-phone behavior
must still be validated using `../docs/MAC_INSTALLER_ACCEPTANCE.md`.
