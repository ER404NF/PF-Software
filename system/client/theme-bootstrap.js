// Runs before style.css loads to set the theme attribute pre-paint (avoids a
// flash of the wrong theme). Was inline in index.html's <head>; moved to its
// own file so a strict Content-Security-Policy (script-src 'self', no
// 'unsafe-inline') can allow it without weakening that policy — see
// index.js's helmet() configuration and PRODUCTION_READINESS_AUDIT.md §7.
(() => {
  try {
    const savedTheme = localStorage.getItem("phone-farm-theme");
    const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = savedTheme === "dark" || savedTheme === "light" ? savedTheme : systemTheme;
  } catch {
    document.documentElement.dataset.theme = "light";
  }
})();
