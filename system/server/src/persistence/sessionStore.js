// Stable persistence port used by express-session. The callback signatures
// are part of the contract; adapters must not silently replace them with a
// Promise-only API because middleware and WebSocket upgrades use the same
// store instance.

export const SESSION_STORE_METHODS = Object.freeze([
  "get",
  "set",
  "destroy",
  "touch",
]);

export function assertSessionStore(store) {
  if (!store || typeof store !== "object") {
    throw new TypeError("session store must be an object");
  }
  for (const method of SESSION_STORE_METHODS) {
    if (typeof store[method] !== "function") {
      throw new TypeError(`session store requires ${method}()`);
    }
  }
  return store;
}
