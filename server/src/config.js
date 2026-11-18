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
const missing = [];

function secret(name, bytes) {
  const v = process.env[name];
  if (v && v.length >= 32) return v;
  if (isProd) { missing.push(name); return ''; }
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

  // Storage. Managed Postgres add-ons inject different variable names:
  // Render uses DATABASE_URL, Vercel/Neon and Supabase use POSTGRES_URL.
  databaseUrl: process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.POSTGRES_PRISMA_URL
    || process.env.POSTGRES_URL_NON_POOLING
    || '',
  sqlitePath: process.env.SQLITE_PATH || './data/polls.db',

  // True on serverless hosts, where each request may run in its own container.
  serverless: !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),

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

if (isProd && !config.adminPasswordHash) missing.push('ADMIN_PASSWORD_HASH');
if (isProd && config.serverless && !config.databaseUrl) {
  missing.push('DATABASE_URL (add a Postgres store to the project)');
}

/* One clear message naming everything that is absent, rather than failing on
   the first one and leaving the operator to discover the rest one deploy at a
   time. */
if (missing.length) {
  throw new Error(
    'Missing required environment variable(s): ' + missing.join(', ')
    + '. Add them in your hosting dashboard and redeploy. The values were '
    + 'written to ADMIN-CREDENTIALS.txt; "npm run keys" regenerates them.'
  );
}

module.exports = config;
