/**
 * TOTP (RFC 6238) — time-based one-time passwords for MFA.
 *
 * Node stdlib only (HMAC-SHA1), no dependency. Enrollment mints a base32 secret and an
 * `otpauth://` provisioning URI the authenticator app scans; verification accepts the
 * current 30-second step plus one on each side to tolerate clock skew.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PERIOD = 30;
const DIGITS = 6;
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Random 20-byte secret, base32-encoded (the size RFC 4226 recommends for SHA1). */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** otpauth:// URI for the QR code. `issuer`/`account` show in the authenticator app. */
export function provisioningUri(secret: string, account: string, issuer = 'woidmod'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(PERIOD) });
  return `otpauth://totp/${label}?${params}`;
}

/** The 6-digit code for a given secret + time (defaults to now). */
export function generateCode(secret: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / PERIOD);
  return hotp(base32Decode(secret), counter);
}

/**
 * Verify a user-entered code against the secret. `window` steps are checked on each
 * side of now (default ±1 = ±30s) to tolerate clock drift. Timing-safe compare.
 */
export function verifyCode(secret: string, code: string, atMs = Date.now(), window = 1): boolean {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const key = base32Decode(secret);
  const step = Math.floor(atMs / 1000 / PERIOD);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(key, step + i);
    if (expected.length === clean.length && timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) {
      return true;
    }
  }
  return false;
}

function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter. Bit-shift only holds 32 bits, so split hi/lo.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
