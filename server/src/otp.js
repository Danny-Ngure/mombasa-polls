'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const { hash, safeEqual } = require('./crypto');

/**
 * One-time-password verification layer.
 *
 * DISABLED BY DEFAULT (OTP_ENABLED=false) because the poll owner chose to let
 * people vote without verifying. Set OTP_ENABLED=true and configure a provider
 * to require a phone code before a ballot is accepted - no code change needed.
 */

function normalisePhone(raw) {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (/^0\d{9}$/.test(s)) s = `+254${s.slice(1)}`;        // Kenyan local form
  if (/^254\d{9}$/.test(s)) s = `+${s}`;
  return s;
}
const validPhone = (s) => /^\+\d{9,15}$/.test(s);

function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/* ----------------------------- providers ----------------------------- */

const providers = {
  async console(to, code) {
    // Development provider: never use in production.
    console.log(`[otp] code for ${to}: ${code}`);
    return { delivered: true, provider: 'console' };
  },

  async africastalking(to, code) {
    const { username, apiKey, from } = config.africastalking;
    if (!username || !apiKey) throw new Error('Africa\'s Talking credentials missing');
    const body = new URLSearchParams({
      username,
      to,
      message: `Your Mombasa Ni Yetu Polls verification code is ${code}. It expires in 10 minutes.`,
    });
    if (from) body.set('from', from);
    const res = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
    if (!res.ok) throw new Error(`Africa's Talking responded ${res.status}`);
    return { delivered: true, provider: 'africastalking' };
  },

  async twilio(to, code) {
    const { sid, token, from } = config.twilio;
    if (!sid || !token || !from) throw new Error('Twilio credentials missing');
    const body = new URLSearchParams({
      To: to,
      From: from,
      Body: `Your Mombasa Ni Yetu Polls verification code is ${code}. It expires in 10 minutes.`,
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      }
    );
    if (!res.ok) throw new Error(`Twilio responded ${res.status}`);
    return { delivered: true, provider: 'twilio' };
  },
};

/* ------------------------------- flow -------------------------------- */

async function request(store, rawPhone) {
  const phone = normalisePhone(rawPhone);
  if (!validPhone(phone)) {
    return { ok: false, error: 'Enter a valid phone number, e.g. 0712345678.' };
  }
  const targetHash = hash(`phone:${phone}`);
  const code = newCode();
  await store.putOtp(targetHash, hash(`code:${code}`), Date.now() + config.otpTtlMs);

  const send = providers[config.otpProvider] || providers.console;
  try {
    await send(phone, code);
  } catch (e) {
    return { ok: false, error: `Could not send the code: ${e.message}` };
  }
  return { ok: true, targetHash, phone };
}

async function verify(store, rawPhone, code) {
  const phone = normalisePhone(rawPhone);
  const targetHash = hash(`phone:${phone}`);
  const rec = await store.getOtp(targetHash);

  if (!rec) return { ok: false, error: 'Request a code first.' };
  if (rec.consumed) return { ok: false, error: 'That code has already been used.' };
  if (Date.now() > rec.expires_at) return { ok: false, error: 'That code has expired.' };
  if (rec.attempts >= config.otpMaxAttempts) {
    return { ok: false, error: 'Too many attempts. Request a new code.' };
  }

  if (!safeEqual(hash(`code:${String(code).trim()}`), rec.code_hash)) {
    await store.bumpOtpAttempts(targetHash);
    return { ok: false, error: 'That code is not correct.' };
  }

  await store.consumeOtp(targetHash);
  return { ok: true, phoneHash: targetHash };
}

module.exports = { request, verify, normalisePhone, validPhone };
