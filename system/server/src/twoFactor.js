import crypto from "crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes) {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let i = 0; i < bits.length; i += 5) {
    output += BASE32[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  }
  return output;
}

function base32Decode(value) {
  const clean = String(value || "").toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  if (!clean || [...clean].some(char => !BASE32.includes(char))) throw new Error("invalid base32 secret");
  let bits = "";
  for (const char of clean) bits += BASE32.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCode(secret, { at = Date.now(), stepSeconds = 30, digits = 6 } = {}) {
  const counter = Math.floor(Number(at) / 1000 / stepSeconds);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

export function verifyTotp(secret, code, { at = Date.now(), window = 1 } = {}) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  const candidate = Buffer.from(code);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = Buffer.from(totpCode(secret, { at: Number(at) + offset * 30_000 }));
    if (expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate)) return true;
  }
  return false;
}

function encryptionKey(masterKey) {
  if (typeof masterKey !== "string" || masterKey.length < 32) {
    const error = new Error("TWO_FACTOR_MASTER_KEY must be configured with at least 32 characters");
    error.status = 503;
    throw error;
  }
  return crypto.createHash("sha256").update(masterKey).digest();
}

export function encryptTotpSecret(secret, masterKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptTotpSecret(stored, masterKey) {
  if (typeof stored !== "string") throw new Error("2FA is not configured");
  const [iv, tag, ciphertext] = stored.split(".");
  if (!iv || !tag || !ciphertext) throw new Error("invalid encrypted 2FA secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(masterKey), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const value = crypto.randomBytes(6).toString("hex").toUpperCase();
    return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
  });
}

export function recoveryCodeDigest(code) {
  return crypto.createHash("sha256").update(String(code || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase()).digest("hex");
}

export function verifyRecoveryCode(code, digests) {
  const candidate = Buffer.from(recoveryCodeDigest(code), "hex");
  return Array.isArray(digests) && digests.findIndex(value => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) return false;
    return crypto.timingSafeEqual(candidate, Buffer.from(value, "hex"));
  });
}

export function otpauthUri({ secret, email, issuer = "Phone Farm" }) {
  const label = `${issuer}:${email}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}
