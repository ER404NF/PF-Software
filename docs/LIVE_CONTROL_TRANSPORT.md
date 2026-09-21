# Live iPhone control transport

Updated 2026-09-21.

## Decision

Keep WebDriverAgent for accessibility, automation, screenshots, and as the
fallback control transport. Do not treat WDA's MJPEG broadcaster as the final
high-performance video path.

For iOS 17 and newer, the preferred next video/control backend is the
CoreDevice display service's device-initiated HEVC stream plus CoreDevice HID
input. It avoids taking and JPEG-encoding a separate screenshot for every
frame. The browser-facing implementation must remain behind Phone Farm's
authenticated stream and input gates; a raw local viewer must never become an
authorization bypass.

“No delay” is not physically possible. USB capture, encoding, transport,
decoding, display refresh, and the phone's input handling each add time. The
acceptance target is a current picture with no queued old frames:

- local USB control: at least 30 displayed frames per second;
- motion-to-picture median at or below 150 ms and p95 at or below 250 ms;
- input-to-visible-response p95 at or below 250 ms;
- no more than one old encoded frame waiting anywhere in the relay;
- no growing delay, smear, or stream drift during a 30-minute session.

Remote viewing also includes the operator-to-hub and hub-to-site round-trip
time, so its lower bound depends on the real network.

## What is in the app now

The existing pipeline is:

1. WDA captures and JPEG-encodes MJPEG frames on the iPhone.
2. `iproxy` forwards the WDA video port over USB.
3. `WdaDevice` parses the MJPEG response.
4. `StreamHub` shares one upstream feed between authorized viewers.
5. The relay sends binary frames through the authenticated WebSocket.
6. The browser discards superseded decode work and paints the newest frame.

The 2026-09-21 low-latency pass changed the default WDA request from 15 fps,
50% scale, quality 35 to 30 fps, 50% scale, quality 45. It also starts dropping
frames when 128 KiB is queued instead of allowing a 1 MB backlog. The normal
phone view is larger and has a full-screen control mode. These changes improve
WDA operation but do not change MJPEG's fundamental capture/encoding cost.

## Candidate transports

### CoreDevice HEVC — recommended experiment

`pymobiledevice3` currently exposes the iOS 17+ CoreDevice display service as a
device-initiated HEVC stream. Its `display serve-web` viewer decodes through
WebCodecs and its universal HID service sends touch and hardware-button input.
The current project documentation reports roughly 53 encoded frames per second
in its recent motion tests.

Requirements include iOS 17+, Developer Mode, a mounted Developer Disk Image,
and an RSD transport. iOS 17.4+ can normally use the no-root userspace tunnel;
older 17.0–17.3 devices have extra tunnel requirements.

The project is GPL-3.0-or-later. Phone Farm currently has no repository license,
so its code or binary must not be bundled until the intended distribution model
and license obligations are decided. A physical proof can use a separately
installed copy without committing or packaging it.

Primary references:

- <https://github.com/doronz88/pymobiledevice3/blob/master/docs/guides/cli-recipes.md>
- <https://github.com/doronz88/pymobiledevice3/blob/master/docs/guides/ios17-tunnels.md>
- <https://github.com/doronz88/pymobiledevice3/releases>
- <https://github.com/doronz88/pymobiledevice3/blob/master/pyproject.toml>

### DeviceKit iOS H.264 / ReplayKit — secondary experiment

DeviceKit iOS offers JSON-RPC input, accessibility, MJPEG, screenshot-based
H.264, and a ReplayKit broadcast extension. The extension can provide a much
smoother system-level H.264 stream, but starting a ReplayKit broadcast can add
an on-phone setup step and is a weaker fit for unattended fleet recovery. Its
current Functional Source License also needs review before distribution.

Reference: <https://github.com/mobile-next/devicekit-ios>

### WDA MJPEG — supported fallback

WDA documents a 1–60 fps screenshot broadcaster with scale and JPEG quality
controls. Higher settings raise device CPU, encoding cost, and bandwidth, so
they do not guarantee lower latency. Keep this path for older phones and for a
known-good fallback.

Reference: <https://github.com/appium/appium-xcuitest-driver/blob/master/docs/guides/mjpeg.md>

## Implementation sequence

1. Run the updated WDA path on the Mac mini and record actual displayed fps and
   tap-to-picture latency. This establishes whether transport replacement is
   necessary for the connected phone model and iOS version.
2. On one iOS 17+ test phone, run `pymobiledevice3` separately and validate
   `display serve-web` plus HID gestures. Record version, setup steps, fps,
   latency, CPU, heat, recovery after unplug/replug, and a 30-minute soak.
3. Decide Phone Farm's distribution/license model before adopting any GPL or
   Functional Source License component.
4. Add a `VideoTransport` and `InputTransport` boundary. Choose CoreDevice per
   device when its probe passes; otherwise choose WDA. Keep all viewer and input
   authorization in the existing server.
5. Relay HEVC access units without transcoding to local Electron/WebCodecs. For
   remote operators, use a bounded real-time transport and discard late frames;
   never convert the stream back to MJPEG.
6. Make the live acceptance thresholds above a release gate for every supported
   phone/iOS combination.

