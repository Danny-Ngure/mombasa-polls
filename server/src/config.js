'use strict';

const crypto = require('node:crypto');

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * In development we generate ephemeral secrets so the app runs with no setup.
 * In production every secret must come from the environment - the process
 * refuses to start otherwise, so a live poll can never run on a throwaway key.
 */
function secret(name, bytes) {
  const v = process.env[name];
  if (v && v.length >= 32) return v;
  if (isProd) {
    throw new Error(
      `${name} is required in production. Generate one with: npm run keys`
    );
  }
  return crypto.randomBytes(bytes).toString('hex');
}

const config = {
  isProd,
  port: int(process.env.PORT, 3000),
  trustProxy: int(process.env.TRUST_PROXY, 1),

  // Secrets
  encryptionKey: secret('DATA_ENCRYPTION_KEY', 32),
  cookieSecret: secret('COOKIE_SECRET', 32),
  hashPepper: secret('HASH_PEPPER', 32),

  // Admin
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  adminPasswordPlain: isProd ? '' : (process.env.ADMIN_PASSWORD || 'mombasa-dev'),

  // Storage
  databaseUrl: process.env.DATABASE_URL || '',
  sqlitePath: process.env.SQLITE_PATH || './data/polls.db',

  // Poll behaviour
  pollHours: int(process.env.POLL_HOURS, 24),
  retentionDays: int(process.env.RETENTION_DAYS, 30),
  autoStart: bool(process.env.AUTO_START_POLL, false),

  // Anti-fraud layers
  rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000),
  rateLimitMaxVotes: int(process.env.RATE_LIMIT_MAX_VOTES, 5),
  maxVotesPerIp: int(process.env.MAX_VOTES_PER_IP, 25),

  // Optional verification layers (off by default - see README)
  otpEnabled: bool(process.env.OTP_ENABLED, false),
  otpProvider: process.env.OTP_PROVIDER || 'console',
  otpTtlMs: int(process.env.OTP_TTL_MS, 10 * 60 * 1000),
  otpMaxAttempts: int(process.env.OTP_MAX_ATTEMPTS, 5),
  africastalking: {
    username: process.env.AT_USERNAME || '',
    apiKey: process.env.AT_API_KEY || '',
    from: process.env.AT_SENDER_ID || '',
  },
  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || '',
    token: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || '',
  },

  captchaEnabled: bool(process.env.CAPTCHA_ENABLED, false),
  hcaptchaSecret: process.env.HCAPTCHA_SECRET || '',
  hcaptchaSiteKey: process.env.HCAPTCHA_SITE_KEY || '',
};

if (isProd && !config.adminPasswordHash) {
  throw new Error(
    'ADMIN_PASSWORD_HASH is required in production. Generate one with: npm run keys'
  );
}

module.exports = config;
