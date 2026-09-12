# Presence and People Contract

Implemented 2026-09-11.

`GET /api/people` and WebSocket `presence_list` messages expose the same safe
staff directory. Every authenticated role has `people:view`. A directory entry
contains only the username, normalized role, online state, last-seen time,
active authenticated-session count, broad activity category, and current phone
labels/IDs. Password hashes, device and research grants, session IDs, cookies,
IP addresses, and raw activity contents are never serialized.

Presence is held in memory because it describes the running relay, not durable
history. An authenticated HTTP-only session is online for 45 seconds after its
last request. Once a browser opens the live WebSocket, heartbeat activity is the
source of truth and closing its final socket marks that session offline. Multiple
tabs with one cookie count as one active session; separate authenticated cookies
count separately. Logout removes the whole session, expiry removes it on the next
validation/cleanup pass, and stale socket records expire after 45 seconds.

Current-phone activity is attached to the individual WebSocket that owns the
human device claim. Selecting, switching, releasing, logout, and disconnect all
update the public roster. The only exposed activity names are `available` and
`device-control`; typed text, URLs, research contents, and other sensitive action
details are outside this contract.

Automated coverage lives in `server/test/unit/presenceStore.test.js` and the
presence scenarios in `server/test/integration/wsProtocol.test.js`.
