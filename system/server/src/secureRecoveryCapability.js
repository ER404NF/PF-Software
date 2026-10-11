const SMTP_KEYS = Object.freeze(["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "COMPANY_FROM_EMAIL"]);

export function smtpConfigurationStatus(environment = process.env) {
  const present = key => typeof environment[key] === "string" && environment[key].trim().length > 0;
  const missing = SMTP_KEYS.filter(key => !present(key));
  if (!missing.includes("SMTP_PORT")) {
    const port = Number(environment.SMTP_PORT);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) missing.push("SMTP_PORT");
  }
  return { configured: missing.length === 0, missing };
}

export function secureRecoveryCapability({
  environment = process.env,
  smtpConfigured = null,
  encryptionConfigured = null,
} = {}) {
  const missing = [];
  if (smtpConfigured === false) missing.push("smtp_delivery");
  else if (smtpConfigured == null) {
    missing.push(...smtpConfigurationStatus(environment).missing);
  }
  const encrypted = encryptionConfigured == null
    ? [environment.ACCOUNT_NOTIFICATION_ENCRYPTION_KEY, environment.TWO_FACTOR_MASTER_KEY]
      .some(value => typeof value === "string" && value.length > 0)
    : encryptionConfigured === true;
  if (!encrypted) missing.push("notification_encryption");
  return { configured: missing.length === 0, missing };
}

export function canUseSecureEmailRecovery({ email, ...options } = {}) {
  return typeof email === "string" && email.trim().length > 0
    && secureRecoveryCapability(options).configured;
}
