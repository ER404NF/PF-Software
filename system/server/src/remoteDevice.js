// A phone that lives at another site, seen from the hub. It has the same surface as
// WdaDevice/MockDevice (tap, drag, typeText, render, openStream, ...) so every part
// of the hub — access rules, the exclusive lease, audit, the live-video relay — works
// on it unchanged. Each call is forwarded to the site agent over the agent link.

import { assertAuthorized } from "./wdaDevice.js";
import { remoteDeviceId } from "./siteProtocol.js";

export class SiteOfflineError extends Error {
  constructor(siteName) {
    super(`${siteName} is not connected to the hub.`);
    this.name = "SiteOfflineError";
    this.code = "SITE_OFFLINE";
  }
}

export class RemoteDevice {
  constructor({ site, localId, label, type = "wda", hub }) {
    this.hub = hub;
    this.siteId = site.id;
    this.siteName = site.name;
    this.timeZone = site.timeZone;
    this.localId = localId;
    this.id = remoteDeviceId(site.id, localId);
    this.label = label;
    this.type = type;
    this.isRemote = true;
    this.status = "offline";
    this.remote = { ready: false, supportsStream: false };
    this.discoveryState = null;
    this.discoveryStateMessage = null;
  }

  get supportsStream() {
    return this.remote.supportsStream === true;
  }

  get siteOnline() {
    return this.hub.isOnline(this.siteId);
  }

  // Same rule WdaDevice.checkReadiness applies: readiness never overwrites "in-use".
  applyReadiness(ready) {
    this.remote.ready = ready;
    if (this.status !== "in-use") this.status = ready && this.siteOnline ? "idle" : "offline";
  }

  async _call(method, args, authorize) {
    assertAuthorized(authorize);
    if (!this.siteOnline) throw new SiteOfflineError(this.siteName);
    const value = await this.hub.call(this.siteId, this.localId, method, args);
    assertAuthorized(authorize); // access may have been revoked while the site was answering
    return value;
  }

  tap(x, y, { authorize } = {}) { return this._call("tap", [x, y], authorize); }
  swipe(direction, { x, y, velocity, authorize } = {}) { return this._call("swipe", [direction, { x, y, velocity }], authorize); }
  drag(x1, y1, x2, y2, holdSec = 0.05, { authorize } = {}) { return this._call("drag", [x1, y1, x2, y2, holdSec], authorize); }
  longPress(x, y, durationSec = 0.8, { authorize } = {}) { return this._call("longPress", [x, y, durationSec], authorize); }
  doubleTap(x, y, { authorize } = {}) { return this._call("doubleTap", [x, y], authorize); }
  typeText(text, { authorize } = {}) { return this._call("typeText", [text], authorize); }
  pressHome({ authorize } = {}) { return this._call("pressHome", [], authorize); }
  render({ authorize } = {}) { return this._call("render", [], authorize); }
  getUiTree() { return this._call("getUiTree", [], undefined); }

  // Live video is relayed hub-side; the hub re-opens it by itself when the site
  // link drops and comes back, reporting "reconnecting" to viewers meanwhile.
  openStream(handlers) {
    return this.hub.openStream(this.siteId, this.localId, handlers);
  }
}
