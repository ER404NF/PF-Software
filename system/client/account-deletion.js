const form = document.getElementById("deletion-request-form");
const identifier = document.getElementById("deletion-identifier");
const message = document.getElementById("deletion-request-message");
const selfForm = document.getElementById("self-deletion-form");
const selfUsername = document.getElementById("self-deletion-username");
const selfPassword = document.getElementById("self-deletion-password");
const selfConfirmation = document.getElementById("self-deletion-confirmation");
const selfMessage = document.getElementById("self-deletion-message");

fetch("/api/me").then(async response => {
  if (!response.ok) return;
  const profile = await response.json();
  selfUsername.textContent = profile.username;
  form.hidden = true;
  selfForm.hidden = false;
}).catch(() => {});

form?.addEventListener("submit", async event => {
  event.preventDefault();
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  message.textContent = "Submitting request…";
  try {
    const response = await fetch("/api/privacy/deletion-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: identifier.value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "The request could not be submitted.");
    form.reset();
    message.textContent = body.message;
  } catch (error) {
    message.textContent = error.message || "The request could not be submitted.";
  } finally {
    submit.disabled = false;
  }
});

selfForm?.addEventListener("submit", async event => {
  event.preventDefault();
  const submit = selfForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  selfMessage.textContent = "Locking the account and recording the request…";
  try {
    const response = await fetch("/api/me/deletion-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: selfPassword.value, confirmation: selfConfirmation.value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "The request could not be submitted.");
    selfForm.reset();
    selfMessage.textContent = "Your account is locked, all sessions are revoked, and the deletion request is recorded.";
  } catch (error) {
    selfMessage.textContent = error.message || "The request could not be submitted.";
    submit.disabled = false;
  }
});
