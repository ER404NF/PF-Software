# VA fleet access

The VA fleet uses the existing `/api/login`, `/api/me`, session store, operator
registry, role capabilities, WebSocket protocol, and device lease. It does not
introduce a second identity or assignment system.

A VA with `fleet:view` sees a safe summary for every configured device. Each
summary is calculated for that viewer and includes `assignedToViewer`, `canOpen`,
`accessState`, and a safe explanation. The client uses those fields to render
assigned, unavailable, and unassigned cards, but the fields are never accepted
back as authorization evidence.

Opening requires all of these server-side checks:

- the HTTP-backed WebSocket session is current;
- the live operator still exists and has `device:control`;
- the device exists and its ID is in the VA's explicit `allowedDevices` array;
- the device is online, idle, and in Human mode;
- no other WebSocket owns the human claim; and
- the human input lease is valid.

Tap, swipe, Home, type, frame refresh, and release recheck the current identity,
grant, selected message device, ownership, and lease. A role/grant/operator
revocation releases ownership and clears the detail view. A revocation that
arrives during an asynchronous action blocks the subsequent render and queued
input.

Operator edits also send a safe `operator_profile` message to every live socket
for that identity before the updated fleet summary. The browser replaces its
cached role, grants, and capabilities immediately. It clears data rendered under
the prior capability set and uses a profile generation to discard late HTTP
responses that began before the edit, preventing an in-flight Admin response
from repopulating privileged UI after demotion.

VA fleet summaries omit assignment instructions, queue details, audit history,
access lists, credentials, secret-bearing proxy data, and private configuration.
VAs cannot mutate assignments or use queue, model, network-check, user/access,
AI-controller, proxy, or security management surfaces.
