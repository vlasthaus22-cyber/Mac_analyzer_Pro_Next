export const ENGINEERING_VIEWS = Object.freeze([
  "single", "filecompare", "multicompare", "enrichment", "batch", "data", "rooms", "guide",
]);
export const USER_VIEWS = Object.freeze(["search", "analytics", "history"]);
export const MIN_ENGINEERING_PASSWORD_LENGTH = 8;
export const DEFAULT_ENGINEERING_SESSION_MINUTES = 30;
export const MIN_ENGINEERING_SESSION_MINUTES = 1;
export const MAX_ENGINEERING_SESSION_MINUTES = 1_440;
const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

const toHex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
};

function cryptoProvider() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) throw new Error("Web Crypto недоступен в этом браузере");
  return globalThis.crypto;
}

async function derivePasswordHash(password, salt, iterations = PBKDF2_ITERATIONS) {
  const crypto = cryptoProvider();
  const key = await crypto.subtle.importKey("raw", new globalThis.TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BYTES * 8));
}

export function normalizeEngineeringSessionMinutes(value, fallback = DEFAULT_ENGINEERING_SESSION_MINUTES) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return fallback;
  return Math.min(MAX_ENGINEERING_SESSION_MINUTES, Math.max(MIN_ENGINEERING_SESSION_MINUTES, Math.round(minutes)));
}

export function canAccessView(view, engineerActive) {
  return USER_VIEWS.includes(view) || (Boolean(engineerActive) && ENGINEERING_VIEWS.includes(view));
}

export async function createEngineerCredential(password) {
  const value = String(password ?? "");
  if (value.length < MIN_ENGINEERING_PASSWORD_LENGTH) throw new Error(`Пароль должен содержать не менее ${MIN_ENGINEERING_PASSWORD_LENGTH} символов`);
  const crypto = cryptoProvider();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePasswordHash(value, salt);
  return { version: 1, algorithm: "PBKDF2-SHA-256", iterations: PBKDF2_ITERATIONS, salt: toHex(salt), hash: toHex(hash) };
}

export async function verifyEngineerCredential(password, credential) {
  if (credential?.version !== 1 || credential.algorithm !== "PBKDF2-SHA-256"
    || !Number.isInteger(credential.iterations) || credential.iterations < 100_000 || credential.iterations > 1_000_000) return false;
  const salt = fromHex(credential.salt);
  const expected = fromHex(credential.hash);
  if (!salt || salt.length !== SALT_BYTES || !expected || expected.length !== HASH_BYTES) return false;
  const actual = await derivePasswordHash(password, salt, credential.iterations);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index] ^ actual[index];
  return difference === 0;
}

export function createEngineeringSession(ttlMinutes, now = Date.now()) {
  const minutes = normalizeEngineeringSessionMinutes(ttlMinutes);
  return { startedAt: now, expiresAt: now + minutes * 60_000, ttlMinutes: minutes };
}

export function isEngineeringSessionActive(session, now = Date.now()) {
  return Number.isFinite(session?.expiresAt) && session.expiresAt > now;
}

export function engineeringSessionRemainingSeconds(session, now = Date.now()) {
  return isEngineeringSessionActive(session, now) ? Math.ceil((session.expiresAt - now) / 1_000) : 0;
}
