(function attachLiveViewController(scope) {
  "use strict";

  const DEFAULT_INTERVAL_MS = 1000;
  const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
  const DEFAULT_MAX_FAILURES = 3;

  class LiveViewController {
    constructor({
      sendRequest,
      isEligible,
      isHidden,
      isInputPending = () => false,
      onStatus,
      onFatalError = () => {},
      intervalMs = DEFAULT_INTERVAL_MS,
      requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      maxFailures = DEFAULT_MAX_FAILURES,
      setIntervalFn = scope.setInterval.bind(scope),
      clearIntervalFn = scope.clearInterval.bind(scope),
      setTimeoutFn = scope.setTimeout.bind(scope),
      clearTimeoutFn = scope.clearTimeout.bind(scope),
    }) {
      if (typeof sendRequest !== "function" || typeof isEligible !== "function"
        || typeof isHidden !== "function" || typeof onStatus !== "function") {
        throw new TypeError("LiveViewController requires send, eligibility, visibility, and status callbacks.");
      }
      this.sendRequest = sendRequest;
      this.isEligible = isEligible;
      this.isHidden = isHidden;
      this.isInputPending = isInputPending;
      this.onStatus = onStatus;
      this.onFatalError = onFatalError;
      this.intervalMs = intervalMs;
      this.requestTimeoutMs = requestTimeoutMs;
      this.maxFailures = maxFailures;
      this.setIntervalFn = setIntervalFn;
      this.clearIntervalFn = clearIntervalFn;
      this.setTimeoutFn = setTimeoutFn;
      this.clearTimeoutFn = clearTimeoutFn;
      this.enabled = false;
      this.deviceId = null;
      this.intervalId = null;
      this.requestTimeoutId = null;
      this.pendingRequest = null;
      this.nextRequestId = 1;
      this.consecutiveFailures = 0;
    }

    start(deviceId) {
      this.stop();
      if (!deviceId || !this.isEligible(deviceId)) return false;
      this.enabled = true;
      this.deviceId = deviceId;
      this.consecutiveFailures = 0;
      this.onStatus(this.isHidden() ? "Live paused" : "Live on", this.isHidden() ? "paused" : "on");
      this.intervalId = this.setIntervalFn(() => this.tick(), this.intervalMs);
      this.tick();
      return true;
    }

    stop({ status = "", state = "off" } = {}) {
      if (this.intervalId !== null) this.clearIntervalFn(this.intervalId);
      if (this.requestTimeoutId !== null) this.clearTimeoutFn(this.requestTimeoutId);
      this.intervalId = null;
      this.requestTimeoutId = null;
      this.pendingRequest = null;
      this.enabled = false;
      this.deviceId = null;
      this.consecutiveFailures = 0;
      this.onStatus(status, state);
    }

    tick() {
      if (!this.enabled) return false;
      if (!this.isEligible(this.deviceId)) {
        this.stop();
        return false;
      }
      if (this.isHidden()) {
        this.onStatus("Live paused", "paused");
        return false;
      }
      if (this.pendingRequest) {
        this.onStatus("Live delayed", "delayed");
        return false;
      }
      if (this.isInputPending()) {
        this.onStatus("Live delayed", "delayed");
        return false;
      }

      const requestId = this.nextRequestId++;
      this.pendingRequest = { requestId, deviceId: this.deviceId, supersededByInput: false };
      this.onStatus("Live on", "on");
      this.requestTimeoutId = this.setTimeoutFn(() => {
        this.failRequest(requestId, "Screenshot refresh timed out.");
      }, this.requestTimeoutMs);

      let sent = false;
      try {
        sent = this.sendRequest({
          type: "refresh_live_frame",
          deviceId: this.deviceId,
          requestId,
        }) !== false;
      } catch (error) {
        this.failRequest(requestId, error?.message || "Screenshot refresh could not be sent.");
        return false;
      }
      if (!sent) {
        this.failRequest(requestId, "Screenshot refresh could not be sent.");
        return false;
      }
      return true;
    }

    supersedePendingFrame() {
      if (this.pendingRequest) this.pendingRequest.supersededByInput = true;
    }

    acceptFrame(message) {
      if (!this.matchesPending(message)) return false;
      const render = !this.pendingRequest.supersededByInput
        && !this.isHidden()
        && this.isEligible(this.deviceId);
      this.clearPendingRequest();
      this.consecutiveFailures = 0;
      this.onStatus(this.isHidden() ? "Live paused" : "Live on", this.isHidden() ? "paused" : "on");
      return render;
    }

    acceptError(message) {
      if (!this.matchesPending(message)) return false;
      this.failRequest(message.requestId, message.message || "Screenshot refresh failed.");
      return true;
    }

    acceptDelayed(message) {
      if (!this.matchesPending(message)) return false;
      this.clearPendingRequest();
      this.onStatus("Live delayed", "delayed");
      return true;
    }

    visibilityChanged() {
      if (!this.enabled) return;
      if (this.isHidden()) {
        this.onStatus("Live paused", "paused");
        return;
      }
      this.onStatus(this.pendingRequest ? "Live delayed" : "Live on", this.pendingRequest ? "delayed" : "on");
      if (!this.pendingRequest) this.tick();
    }

    isActiveFor(deviceId) {
      return this.enabled && this.deviceId === deviceId;
    }

    matchesPending(message) {
      return Boolean(this.enabled && this.pendingRequest
        && message?.deviceId === this.pendingRequest.deviceId
        && message?.requestId === this.pendingRequest.requestId);
    }

    clearPendingRequest() {
      if (this.requestTimeoutId !== null) this.clearTimeoutFn(this.requestTimeoutId);
      this.requestTimeoutId = null;
      this.pendingRequest = null;
    }

    failRequest(requestId, message) {
      if (!this.pendingRequest || this.pendingRequest.requestId !== requestId) return;
      this.clearPendingRequest();
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.maxFailures) {
        const fatalMessage = `Live view stopped after ${this.consecutiveFailures} screenshot failures. ${message}`;
        this.stop({ status: "Live error", state: "error" });
        this.onFatalError(fatalMessage);
        return;
      }
      this.onStatus("Live error", "error");
    }
  }

  scope.LiveViewController = LiveViewController;
})(typeof window === "undefined" ? globalThis : window);
