// Adaptive pacing (roadmap MS13.3): how long to wait between steps.
//
// A fixed delay is either too slow (the screen was ready long ago) or too fast (the app
// has not finished drawing). This waits a short base time while the screen keeps
// changing, then backs off while it is unchanged (a loading spinner, an idle feed), which
// also spares the phone and the model. It never waits LESS than the app needs to settle,
// because observing a half-drawn screen would cost far more than it saves.

export class AdaptivePacing {
  constructor({ baseMs = 400, maxMs = 8000, settleMs = 300, factor = 2 } = {}) {
    if (baseMs < settleMs) throw new RangeError("the base delay must be at least the settle time");
    Object.assign(this, { baseMs, maxMs, settleMs, factor });
    this.lastFingerprint = null;
    this.stable = 0;
  }

  // `fingerprint` describes what was on screen after the last step.
  next(fingerprint) {
    if (fingerprint !== null && fingerprint === this.lastFingerprint) this.stable += 1;
    else this.stable = 0;
    this.lastFingerprint = fingerprint;
    return Math.min(this.maxMs, Math.round(this.baseMs * this.factor ** this.stable));
  }

  reset() {
    this.lastFingerprint = null;
    this.stable = 0;
  }
}
