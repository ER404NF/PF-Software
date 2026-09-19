// The phone-shaped control surface. The operator sees a live picture of the phone
// and drives it the way they would the real thing:
//
//   click            -> tap             double click -> double tap
//   press and hold   -> long press      drag         -> finger drag (scroll, swipe, back-swipe from the edge)
//   mouse wheel      -> scroll          arrow keys / Page Up / Page Down -> scroll
//   keyboard         -> types into the focused field on the phone (Backspace, Enter, paste, IME)
//   home button      -> the bezel button under the screen
//
// There are no arrow buttons, Home text button or "type here" box any more. Video
// arrives as binary WebSocket frames [kind:1][streamId:4][image bytes] and is drawn
// to a canvas; JSON screenshots (the fallback for phones without a video port) are
// drawn to the same canvas. Everything that touches the DOM is injected, so the
// gesture logic is unit-tested in Node (server/test/unit/phoneStage.test.js).

(function attachPhoneStage(scope) {
  "use strict";

  const TAP_TRAVEL_PX = 8;          // less movement than this is still a tap
  const LONG_PRESS_MS = 550;        // held this long without moving = long press
  const HOLD_DRAG_MS = 450;         // held still this long before moving = press-and-drag
  const DEFAULT_DRAG_HOLD_MS = 50;  // the short press WDA needs before a scrolling drag
  const DOUBLE_TAP_MS = 350;
  const DOUBLE_TAP_DISTANCE = 0.05; // of the screen size
  const WHEEL_THROTTLE_MS = 60;
  const WHEEL_MIN_FRACTION = 0.05;
  const WHEEL_MAX_FRACTION = 0.5;
  const IN_FLIGHT_TIMEOUT_MS = 2500;
  const TEXT_FLUSH_MS = 30;
  const TEXT_CHUNK = 400;
  const KIND_MIME = { 1: "image/jpeg", 2: "image/png", 3: "image/svg+xml" };
  const KEY_SCROLL_FRACTION = { ArrowUp: 0.25, ArrowDown: 0.25, ArrowLeft: 0.35, ArrowRight: 0.35, PageUp: 0.6, PageDown: 0.6 };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  // ---- pure helpers ---------------------------------------------------------

  // Screen position of a mouse/touch point as 0..1 of the displayed picture.
  function pointInRect(rect, clientX, clientY) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    return {
      x: clamp((clientX - rect.left) / rect.width, 0, 1),
      y: clamp((clientY - rect.top) / rect.height, 0, 1),
    };
  }

  // Turns a finished press into the phone gesture it stands for.
  // gesture: { startX, startY, endX, endY (0..1), startedAt, endedAt, movedAt|null, maxTravelPx }
  function classifyGesture(gesture, { travelPx = TAP_TRAVEL_PX, longPressMs = LONG_PRESS_MS, holdDragMs = HOLD_DRAG_MS } = {}) {
    if (gesture.maxTravelPx < travelPx) {
      const heldMs = gesture.endedAt - gesture.startedAt;
      if (heldMs >= longPressMs) {
        return { type: "long_press", x: gesture.startX, y: gesture.startY, durationMs: Math.round(clamp(heldMs, 300, 5000)) };
      }
      return { type: "tap", x: gesture.endX, y: gesture.endY };
    }
    const heldBeforeMoving = gesture.movedAt === null ? 0 : gesture.movedAt - gesture.startedAt;
    return {
      type: "drag",
      x1: gesture.startX, y1: gesture.startY, x2: gesture.endX, y2: gesture.endY,
      holdMs: heldBeforeMoving >= holdDragMs ? Math.round(clamp(heldBeforeMoving, 0, 3000)) : DEFAULT_DRAG_HOLD_MS,
    };
  }

  // A scroll of `amount` (fraction of the screen, always positive) in the direction
  // the content should move, as a finger drag centred near `pointer` and kept clear
  // of the screen edges (an edge drag would trigger iOS system gestures instead).
  // `fingerSign` is the direction the finger travels: -1 = up/left, +1 = down/right.
  function scrollDrag({ vertical, fingerSign, amount, pointer }) {
    const half = clamp(amount, WHEEL_MIN_FRACTION, WHEEL_MAX_FRACTION) / 2;
    const along = vertical ? pointer.y : pointer.x;
    const centre = clamp(along, 0.1 + half, 0.9 - half);
    const across = clamp(vertical ? pointer.x : pointer.y, 0.12, 0.88);
    const from = centre - fingerSign * half;
    const to = centre + fingerSign * half;
    return vertical
      ? { type: "drag", x1: across, y1: from, x2: across, y2: to, holdMs: 30 }
      : { type: "drag", x1: from, y1: across, x2: to, y2: across, holdMs: 30 };
  }

  // Accumulated wheel movement (in CSS pixels) -> one drag. Scrolling down moves
  // the content up, so the finger travels up.
  function wheelDragMessage({ dx, dy, pointer, rect }) {
    const vertical = Math.abs(dy) >= Math.abs(dx);
    const delta = vertical ? dy : dx;
    const size = vertical ? rect.height : rect.width;
    if (!(size > 0) || Math.abs(delta) < 1) return null;
    return scrollDrag({ vertical, fingerSign: delta > 0 ? -1 : 1, amount: Math.abs(delta) / size, pointer });
  }

  // Keys with a phone meaning of their own. Everything printable goes through the
  // hidden text field's input events instead, so IME, dead keys and paste all work.
  function keyAction(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    switch (event.key) {
      case "Backspace": return { text: "\b" };
      case "Enter": return { text: "\n" };
      case "ArrowUp": return { scroll: { vertical: true, fingerSign: 1, amount: KEY_SCROLL_FRACTION.ArrowUp } };
      case "ArrowDown": return { scroll: { vertical: true, fingerSign: -1, amount: KEY_SCROLL_FRACTION.ArrowDown } };
      case "PageUp": return { scroll: { vertical: true, fingerSign: 1, amount: KEY_SCROLL_FRACTION.PageUp } };
      case "PageDown": return { scroll: { vertical: true, fingerSign: -1, amount: KEY_SCROLL_FRACTION.PageDown } };
      case "ArrowLeft": return { scroll: { vertical: false, fingerSign: 1, amount: KEY_SCROLL_FRACTION.ArrowLeft } };
      case "ArrowRight": return { scroll: { vertical: false, fingerSign: -1, amount: KEY_SCROLL_FRACTION.ArrowRight } };
      default: return null;
    }
  }

  // Fast typing arrives as many tiny events; the phone wants few, ordered messages.
  class TextBatcher {
    constructor({ send, setTimeoutFn = scope.setTimeout.bind(scope), clearTimeoutFn = scope.clearTimeout.bind(scope), flushMs = TEXT_FLUSH_MS, chunk = TEXT_CHUNK }) {
      this.send = send;
      this.setTimeoutFn = setTimeoutFn;
      this.clearTimeoutFn = clearTimeoutFn;
      this.flushMs = flushMs;
      this.chunk = chunk;
      this.buffer = "";
      this.timer = null;
    }

    push(text) {
      if (!text) return;
      this.buffer += text;
      if (this.buffer.length >= this.chunk) this.flush();
      else if (this.timer === null) this.timer = this.setTimeoutFn(() => this.flush(), this.flushMs);
    }

    flush() {
      if (this.timer !== null) this.clearTimeoutFn(this.timer);
      this.timer = null;
      while (this.buffer.length > 0) {
        const part = this.buffer.slice(0, this.chunk);
        this.buffer = this.buffer.slice(this.chunk);
        this.send({ type: "type_text", text: part });
      }
    }
  }

  function browserDecode(bytes, kind) {
    const mime = KIND_MIME[kind];
    if (!mime) return Promise.reject(new Error("unknown frame kind"));
    const blob = new Blob([bytes], { type: mime });
    // SVG (the simulator) cannot go through createImageBitmap in every browser.
    if (kind !== 3 && typeof scope.createImageBitmap === "function") return scope.createImageBitmap(blob);
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not decode frame")); };
      image.src = url;
    });
  }

  function base64ToBytes(base64) {
    const binary = scope.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  // ---- the stage ------------------------------------------------------------

  class PhoneStage {
    // screenEl: host element that receives the <canvas>; also receives pointer/wheel input
    // frameEl: the bezel (gets state classes); homeButtonEl: the bezel's home button
    // dotEl: the touch indicator; keyboardEl: the hidden text field that captures typing
    // send(message) -> requestId | null: sends an input to the phone (the app adds deviceId)
    constructor({
      screenEl, frameEl = null, homeButtonEl = null, dotEl = null, keyboardEl = null,
      send, onStatus = () => {},
      now = () => Date.now(),
      setTimeoutFn = scope.setTimeout.bind(scope),
      clearTimeoutFn = scope.clearTimeout.bind(scope),
      createCanvas = () => scope.document.createElement("canvas"),
      decode = browserDecode,
      coarsePointer = () => Boolean(scope.matchMedia?.("(pointer: coarse)")?.matches),
    }) {
      if (!screenEl || typeof send !== "function") throw new TypeError("PhoneStage needs a screen element and a send callback.");
      Object.assign(this, { screenEl, frameEl, homeButtonEl, dotEl, keyboardEl, send, onStatus, now, setTimeoutFn, clearTimeoutFn, createCanvas, decode, coarsePointer });
      this.mode = "idle"; // idle | control | watch
      this.streamId = null;
      this.canvas = null;
      this.pendingFrame = null;
      this.decoding = false;
      this.gesture = null;
      this.lastTap = null;
      this.wheel = { dx: 0, dy: 0, pointer: { x: 0.5, y: 0.5 }, timer: null, inFlight: null };
      this.inFlight = new Map(); // requestId -> timeout id
      this.frameCount = 0;
      this.decodeFailures = 0;
      this.streamFrames = 0;  // video frames drawn for the current stream
      this.picture = false;   // something is on the canvas
      this.fpsWindow = { startedAt: now(), frames: 0 };
      this.fps = 0;
      this.holdTimer = null;
      this.dotTimer = null;
      this.batcher = new TextBatcher({ send: message => this._sendInput(message), setTimeoutFn, clearTimeoutFn });
      this._bind();
    }

    // ---- state -------------------------------------------------------------

    setMode(mode) {
      if (this.mode === mode) return;
      this.mode = mode;
      this._cancelGesture();
      this.batcher.buffer = "";
      this.frameEl?.classList?.toggle("controllable", mode === "control");
      this.frameEl?.classList?.toggle("watching", mode === "watch");
      if (this.homeButtonEl) this.homeButtonEl.disabled = mode !== "control";
      if (mode !== "control") this.settleAll();
    }

    setStream(streamId) {
      this.streamId = streamId;
      this.streamFrames = 0;
      this.fpsWindow = { startedAt: this.now(), frames: 0 };
    }

    clear() {
      this._cancelGesture();
      this.pendingFrame = null;
      this.streamId = null;
      this.streamFrames = 0;
      this.picture = false;
      this.fps = 0;
      if (this.canvas) {
        const context = this.canvas.getContext?.("2d");
        context?.clearRect?.(0, 0, this.canvas.width, this.canvas.height);
      }
      this.frameEl?.classList?.remove("has-picture");
    }

    get canInput() {
      return this.mode === "control";
    }

    get hasPicture() {
      return this.picture;
    }

    // ---- picture -----------------------------------------------------------

    // Binary WebSocket frame: 1 byte kind, 4 bytes stream id, then the image.
    handleBinary(buffer) {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      if (bytes.length <= 5) return false;
      const streamId = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
      if (this.streamId === null || streamId !== this.streamId) return false; // a stale stream's frame
      this.streamFrames += 1;
      this.showFrame(bytes.subarray(5), bytes[0]);
      return true;
    }

    // A screenshot from the JSON protocol (fallback path).
    showLegacyFrame(frame) {
      if (frame?.kind === "image" && typeof frame.data === "string") {
        const kind = /jpe?g/i.test(frame.mime || "") ? 1 : 2;
        this.showFrame(base64ToBytes(frame.data), kind);
      } else if (typeof frame?.data === "string") {
        this.showFrame(new TextEncoder().encode(frame.data), 3);
      }
    }

    showFrame(bytes, kind) {
      this.pendingFrame = { bytes, kind };
      if (!this.decoding) void this._drain();
    }

    async _drain() {
      this.decoding = true;
      try {
        while (this.pendingFrame) {
          const { bytes, kind } = this.pendingFrame;
          this.pendingFrame = null; // frames that arrive while decoding replace this slot: newest wins
          try {
            this._paint(await this.decode(bytes, kind));
            this.decodeFailures = 0;
          } catch {
            // One undecodable frame is skipped and the next one repaints; a run of
            // them means the picture cannot be shown at all, which must be visible.
            this.decodeFailures += 1;
            if (this.decodeFailures === 5) this.onStatus("decode-error", this.decodeFailures);
          }
        }
      } finally {
        this.decoding = false;
      }
    }

    _paint(image) {
      const width = image.width || image.naturalWidth;
      const height = image.height || image.naturalHeight;
      if (!(width > 0) || !(height > 0)) return;
      if (!this.canvas) {
        this.canvas = this.createCanvas();
        this.canvas.className = "phone-canvas";
        this.screenEl.replaceChildren(this.canvas);
      }
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.canvas.getContext("2d").drawImage(image, 0, 0, width, height);
      image.close?.();
      this.frameEl?.classList?.add("has-picture");
      this.picture = true;
      this.frameCount += 1;
      this.fpsWindow.frames += 1;
      const elapsed = this.now() - this.fpsWindow.startedAt;
      if (elapsed >= 2000) {
        this.fps = Math.round((this.fpsWindow.frames * 1000) / elapsed);
        this.fpsWindow = { startedAt: this.now(), frames: 0 };
        this.onStatus("fps", this.fps);
      }
    }

    displayRect() {
      const target = this.canvas || this.screenEl;
      return target.getBoundingClientRect();
    }

    // ---- input plumbing ----------------------------------------------------

    _sendInput(message) {
      if (!this.canInput) return null;
      const requestId = this.send(message);
      if (typeof requestId === "number") {
        this.inFlight.set(requestId, this.setTimeoutFn(() => this.actionSettled(requestId), IN_FLIGHT_TIMEOUT_MS));
      }
      return requestId ?? null;
    }

    // The server acknowledged (or a screenshot answered) an input.
    actionSettled(requestId) {
      const timer = this.inFlight.get(requestId);
      if (timer !== undefined) this.clearTimeoutFn(timer);
      this.inFlight.delete(requestId);
      if (this.wheel.inFlight === requestId) {
        this.wheel.inFlight = null;
        if (this.wheel.dx || this.wheel.dy) this._scheduleWheel();
      }
    }

    settleAll() {
      for (const requestId of [...this.inFlight.keys()]) this.actionSettled(requestId);
      this.wheel.inFlight = null;
    }

    // ---- DOM events --------------------------------------------------------

    _bind() {
      if (this.homeButtonEl) this.homeButtonEl.disabled = true; // until a phone is being controlled
      const screen = this.screenEl;
      screen.addEventListener("pointerdown", event => this._onPointerDown(event));
      screen.addEventListener("pointermove", event => this._onPointerMove(event));
      screen.addEventListener("pointerup", event => this._onPointerUp(event));
      screen.addEventListener("pointercancel", () => this._cancelGesture());
      screen.addEventListener("wheel", event => this._onWheel(event), { passive: false });
      screen.addEventListener("contextmenu", event => { if (this.canInput) event.preventDefault(); });
      screen.addEventListener("dragstart", event => event.preventDefault?.());
      this.homeButtonEl?.addEventListener("click", () => {
        if (this.canInput) {
          this.batcher.flush();
          this._sendInput({ type: "home" });
          this._pulseHome();
        }
      });
      this._bindKeyboard();
    }

    _bindKeyboard() {
      const field = this.keyboardEl;
      if (!field) return;
      field.addEventListener("keydown", event => {
        if (!this.canInput || event.isComposing) return;
        const action = keyAction(event);
        if (!action) return;
        event.preventDefault();
        if (action.text !== undefined) {
          this.batcher.push(action.text);
        } else {
          this.batcher.flush();
          const message = scrollDrag({ ...action.scroll, pointer: { x: 0.5, y: 0.5 } });
          this._sendInput(message);
        }
      });
      field.addEventListener("paste", event => {
        if (!this.canInput) return;
        const text = event.clipboardData?.getData?.("text/plain");
        if (text) {
          event.preventDefault();
          this.batcher.push(text.replace(/\r\n?/g, "\n"));
        }
      });
      field.addEventListener("beforeinput", event => {
        if (!this.canInput || event.isComposing || event.inputType === "insertCompositionText") return;
        if (typeof event.inputType === "string" && event.inputType.startsWith("insert")) {
          const text = event.data ?? event.dataTransfer?.getData?.("text/plain") ?? "";
          if (text) {
            event.preventDefault();
            this.batcher.push(String(text).replace(/\r\n?/g, "\n"));
          }
        } else if (event.inputType === "deleteContentBackward") {
          event.preventDefault();
          this.batcher.push("\b");
        }
      });
      field.addEventListener("compositionend", event => {
        if (this.canInput && event.data) this.batcher.push(event.data);
        field.value = "";
      });
      field.addEventListener("focus", () => this.frameEl?.classList?.add("keyboard-active"));
      field.addEventListener("blur", () => {
        this.batcher.flush();
        this.frameEl?.classList?.remove("keyboard-active");
      });
    }

    focusKeyboard() {
      this.keyboardEl?.focus?.({ preventScroll: true });
    }

    _onPointerDown(event) {
      if (!this.canInput || (event.pointerType === "mouse" && event.button !== 0)) return;
      const point = pointInRect(this.displayRect(), event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault?.();
      this.screenEl.setPointerCapture?.(event.pointerId);
      const at = this.now();
      this.gesture = {
        id: event.pointerId, startedAt: at, startX: point.x, startY: point.y, endX: point.x, endY: point.y,
        originPx: event.clientX, originPy: event.clientY, maxTravelPx: 0, movedAt: null, endedAt: at,
      };
      this._showDot(event, false);
      this.holdTimer = this.setTimeoutFn(() => this.dotEl?.classList?.add("holding"), LONG_PRESS_MS);
      if (!(event.pointerType === "touch" || this.coarsePointer())) this.focusKeyboard();
    }

    _onPointerMove(event) {
      const gesture = this.gesture;
      if (!gesture || event.pointerId !== gesture.id) return;
      const point = pointInRect(this.displayRect(), event.clientX, event.clientY);
      if (!point) return;
      gesture.endX = point.x;
      gesture.endY = point.y;
      gesture.maxTravelPx = Math.max(gesture.maxTravelPx, Math.hypot(event.clientX - gesture.originPx, event.clientY - gesture.originPy));
      if (gesture.movedAt === null && gesture.maxTravelPx >= TAP_TRAVEL_PX) {
        gesture.movedAt = this.now();
        this.clearTimeoutFn(this.holdTimer);
        this.dotEl?.classList?.remove("holding");
      }
      this._showDot(event, true);
    }

    _onPointerUp(event) {
      const gesture = this.gesture;
      if (!gesture || event.pointerId !== gesture.id) return;
      const point = pointInRect(this.displayRect(), event.clientX, event.clientY);
      if (point) { gesture.endX = point.x; gesture.endY = point.y; }
      gesture.endedAt = this.now();
      this._cancelGesture({ keepDot: true });
      this.screenEl.releasePointerCapture?.(event.pointerId);
      const action = classifyGesture(gesture);
      if (action.type === "tap") {
        const last = this.lastTap;
        const isDouble = last && gesture.endedAt - last.at <= DOUBLE_TAP_MS
          && Math.hypot(action.x - last.x, action.y - last.y) <= DOUBLE_TAP_DISTANCE;
        this.lastTap = isDouble ? null : { at: gesture.endedAt, x: action.x, y: action.y };
        if (isDouble) action.type = "double_tap";
      } else {
        this.lastTap = null;
      }
      this.batcher.flush();
      this._sendInput(action);
      this.dotTimer = this.setTimeoutFn(() => this._hideDot(), 160);
    }

    _cancelGesture({ keepDot = false } = {}) {
      this.gesture = null;
      this.clearTimeoutFn(this.holdTimer);
      this.holdTimer = null;
      if (!keepDot) this._hideDot();
    }

    _onWheel(event) {
      if (!this.canInput) return; // not controlling: let the page scroll normally
      event.preventDefault();
      const rect = this.displayRect();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      this.wheel.dx += (event.deltaX || 0) * scale;
      this.wheel.dy += (event.deltaY || 0) * scale;
      // Shift + wheel scrolls sideways, as it does in every desktop app.
      if (event.shiftKey && !event.deltaX) { this.wheel.dx += this.wheel.dy; this.wheel.dy = 0; }
      const point = pointInRect(rect, event.clientX, event.clientY);
      if (point) this.wheel.pointer = point;
      this._scheduleWheel();
    }

    _scheduleWheel() {
      if (this.wheel.timer !== null || this.wheel.inFlight !== null) return;
      this.wheel.timer = this.setTimeoutFn(() => {
        this.wheel.timer = null;
        this._flushWheel();
      }, WHEEL_THROTTLE_MS);
    }

    _flushWheel() {
      if (this.wheel.inFlight !== null || !this.canInput) return;
      const { dx, dy, pointer } = this.wheel;
      this.wheel.dx = 0;
      this.wheel.dy = 0;
      const message = wheelDragMessage({ dx, dy, pointer, rect: this.displayRect() });
      if (!message) return;
      this.batcher.flush();
      const requestId = this._sendInput(message);
      // A message that could not be sent or is never acknowledged must not stall scrolling.
      this.wheel.inFlight = typeof requestId === "number" ? requestId : null;
    }

    // ---- touch indicator ---------------------------------------------------

    _showDot(event, moving) {
      const dot = this.dotEl;
      if (!dot) return;
      this.clearTimeoutFn(this.dotTimer);
      // Positioned inside the dot's own container (the glass), not the canvas host.
      const rect = (dot.parentElement || this.screenEl).getBoundingClientRect();
      dot.hidden = false;
      dot.classList?.toggle("moving", moving);
      dot.style.transform = `translate(${event.clientX - rect.left}px, ${event.clientY - rect.top}px)`;
    }

    _hideDot() {
      if (!this.dotEl) return;
      this.dotEl.hidden = true;
      this.dotEl.classList?.remove("holding", "moving");
    }

    _pulseHome() {
      const button = this.homeButtonEl;
      button?.classList?.add("pressed");
      this.setTimeoutFn(() => button?.classList?.remove("pressed"), 160);
    }
  }

  PhoneStage.helpers = { pointInRect, classifyGesture, scrollDrag, wheelDragMessage, keyAction, TextBatcher };
  PhoneStage.constants = { TAP_TRAVEL_PX, LONG_PRESS_MS, HOLD_DRAG_MS, DOUBLE_TAP_MS };
  scope.PhoneStage = PhoneStage;
})(typeof window === "undefined" ? globalThis : window);
