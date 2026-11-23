'use strict';

const crypto = require('node:crypto');
const config = require('./config');

/** Derive a stable 32-byte key from whatever the operator supplied. */
const KEY = crypto.createHash('sha256').update(String(config.encryptionKey)).digest();

/**
 * Encrypt personally identifying data at rest (AES-256-GCM).
 * Output: base64(iv[12] | authTag[16] | ciphertext)
 */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return '';
  try {
    const raw = Buffer.from(blob, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    return '[unreadable - wrong DATA_ENCRYPTION_KEY]';
  }
}

/** Keyed one-way hash. Used for IPs, device tokens and phone numbers so the
 *  raw values are never stored, while duplicates remain detectable. */
function hash(value) {
  return crypto.createHmac('sha256', config.hashPepper)
    .update(String(value)).digest('hex');
}

/** Short, non-reversible reference shown in the admin UI and CSV. */
function shortRef(value) {
  return hash(value).slice(0, 8).toUpperCase();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/* ---------- signed cookies ---------- */

function sign(value) {
  const sig = crypto.createHmac('sha256', config.cookieSecret)
    .update(value).digest('base64url');
  return `${value}.${sig}`;
}

function unsign(signed) {
  if (typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  const expected = sign(value);
  const a = Buffer.from(signed);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/* ---------- admin password ---------- */

/**
 * Two accepted encodings of the same scrypt hash:
 *   - "scrypt$<saltHex>$<keyHex>"  (168 chars) - traditional, readable
 *   - base64url(salt16 || key64)   (108 chars) - COMPACT, preferred
 *
 * The compact form exists because the traditional one contains `$`, which
 * shells expand when an env file is sourced, and its length invites a
 * half-selected paste into a hosting dashboard. The compact form is shorter
 * and uses only [A-Za-z0-9_-], so it survives every paste path intact.
 */
const SCRYPT_RE = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{128})$/;
const COMPACT_RE = /^[A-Za-z0-9_-]{105,112}$/;

/** Accept either encoding; return {salt, key} or null. */
function parseStoredHash(stored) {
  const s = String(stored || '').trim();
  const m = SCRYPT_RE.exec(s);
  if (m) return { salt: Buffer.from(m[1], 'hex'), key: Buffer.from(m[2], 'hex') };
  if (COMPACT_RE.test(s)) {
    try {
      const raw = Buffer.from(s, 'base64url');
      if (raw.length === 80) {
        return { salt: raw.subarray(0, 16), key: raw.subarray(16) };
      }
    } catch { /* fall through */ }
  }
  return null;
}

/** True when a stored value is a usable hash in either encoding. */
const isValidStoredHash = (stored) => parseStoredHash(stored) !== null;

/** Produce the compact form. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64);
  return Buffer.concat([salt, key]).toString('base64url');
}

function verifyPassword(password, stored) {
  try {
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;
    const key = crypto.scryptSync(String(password), parsed.salt, 64);
    return key.length === parsed.key.length && crypto.timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
}

/** Constant-time comparison for plain strings (dev admin password, OTP codes). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  encrypt, decrypt, hash, shortRef, randomToken,
  sign, unsign, parseCookies,
  hashPassword, verifyPassword, isValidStoredHash, safeEqual,
};
