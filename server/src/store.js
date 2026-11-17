'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

/**
 * Two storage backends behind one async interface.
 *   - Postgres when DATABASE_URL is set (managed hosting, e.g. Render).
 *   - SQLite otherwise, via Node's built-in node:sqlite (no native build step).
 *
 * Personally identifying columns (_enc suffix) hold AES-256-GCM ciphertext and
 * are only ever decrypted inside the admin routes.
 */

const DDL_SQLITE = [
  `CREATE TABLE IF NOT EXISTS poll_config (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     status TEXT NOT NULL DEFAULT 'idle',
     opens_at INTEGER,
     closes_at INTEGER,
     publish_after_close INTEGER NOT NULL DEFAULT 0,
     contact_email TEXT NOT NULL DEFAULT '',
     updated_at INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS votes (
     id TEXT PRIMARY KEY,
     voter_token_hash TEXT NOT NULL UNIQUE,
     phone_hash TEXT UNIQUE,
     candidate_id TEXT NOT NULL,
     age_bracket TEXT NOT NULL,
     gender TEXT NOT NULL,
     gender_other_enc TEXT NOT NULL DEFAULT '',
     full_name_enc TEXT NOT NULL DEFAULT '',
     constituency_enc TEXT NOT NULL DEFAULT '',
     ip_hash TEXT NOT NULL DEFAULT '',
     ua_hash TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     invalid INTEGER NOT NULL DEFAULT 0,
     purged INTEGER NOT NULL DEFAULT 0,
     flags TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS votes_ip_idx ON votes (ip_hash, created_at)`,
  `CREATE TABLE IF NOT EXISTS audit (
     id TEXT PRIMARY KEY,
     at INTEGER NOT NULL,
     action TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '',
     actor TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS otp_codes (
     target_hash TEXT PRIMARY KEY,
     code_hash TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     consumed INTEGER NOT NULL DEFAULT 0
   )`,
];

const DDL_PG = DDL_SQLITE.map((s) =>
  s.replace(/INTEGER PRIMARY KEY CHECK \(id = 1\)/, 'INTEGER PRIMARY KEY CHECK (id = 1)')
   .replace(/\bINTEGER\b/g, 'BIGINT')
);

const num = (v) => (v === null || v === undefined ? null : Number(v));

function mapVote(r) {
  return {
    id: r.id,
    voter_token_hash: r.voter_token_hash,
    phone_hash: r.phone_hash || null,
    candidate_id: r.candidate_id,
    age_bracket: r.age_bracket,
    gender: r.gender,
    gender_other_enc: r.gender_other_enc || '',
    full_name_enc: r.full_name_enc || '',
    constituency_enc: r.constituency_enc || '',
    ip_hash: r.ip_hash || '',
    ua_hash: r.ua_hash || '',
    created_at: num(r.created_at),
    invalid: !!num(r.invalid),
    purged: !!num(r.purged),
    flags: r.flags || '',
  };
}

function mapConfig(r) {
  if (!r) return null;
  return {
    status: r.status,
    opensAt: num(r.opens_at),
    closesAt: num(r.closes_at),
    publishAfterClose: !!num(r.publish_after_close),
    contactEmail: r.contact_email || '',
    updatedAt: num(r.updated_at),
  };
}

const DUPLICATE = 'DUPLICATE_VOTE';

/* ------------------------------------------------------------------ SQLite */

function sqliteStore() {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.resolve(config.sqlitePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const stmt of DDL_SQLITE) db.exec(stmt);

  const dup = (e) => /UNIQUE constraint failed/i.test(String(e && e.message));

  return {
    kind: 'sqlite',
    async close() { db.close(); },

    async getConfig() {
      return mapConfig(db.prepare('SELECT * FROM poll_config WHERE id = 1').get());
    },
    async setConfig(c) {
      db.prepare(
        `INSERT INTO poll_config (id, status, opens_at, closes_at,
           publish_after_close, contact_email, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status,
           opens_at = excluded.opens_at, closes_at = excluded.closes_at,
           publish_after_close = excluded.publish_after_close,
           contact_email = excluded.contact_email,
           updated_at = excluded.updated_at`
      ).run(c.status, c.opensAt, c.closesAt,
            c.publishAfterClose ? 1 : 0, c.contactEmail || '', Date.now());
      return this.getConfig();
    },

    async insertVote(v) {
      try {
        db.prepare(
          `INSERT INTO votes (id, voter_token_hash, phone_hash, candidate_id,
             age_bracket, gender, gender_other_enc, full_name_enc,
             constituency_enc, ip_hash, ua_hash, created_at, invalid, purged, flags)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,?)`
        ).run(v.id, v.voter_token_hash, v.phone_hash, v.candidate_id,
              v.age_bracket, v.gender, v.gender_other_enc, v.full_name_enc,
              v.constituency_enc, v.ip_hash, v.ua_hash, v.created_at, v.flags || '');
      } catch (e) {
        if (dup(e)) { const err = new Error(DUPLICATE); err.code = DUPLICATE; throw err; }
        throw e;
      }
    },
    async listVotes() {
      return db.prepare('SELECT * FROM votes ORDER BY created_at ASC').all().map(mapVote);
    },
    async findByToken(tokenHash) {
      const r = db.prepare('SELECT * FROM votes WHERE voter_token_hash = ?').get(tokenHash);
      return r ? mapVote(r) : null;
    },
    async countByIpSince(ipHash, since) {
      const r = db.prepare(
        'SELECT COUNT(*) AS n FROM votes WHERE ip_hash = ? AND created_at >= ?'
      ).get(ipHash, since);
      return Number(r.n);
    },
    async countByIp(ipHash) {
      const r = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE ip_hash = ?').get(ipHash);
      return Number(r.n);
    },
    async setInvalid(id, invalid) {
      db.prepare('UPDATE votes SET invalid = ? WHERE id = ?').run(invalid ? 1 : 0, id);
    },
    async purgeOlderThan(cutoff) {
      const r = db.prepare(
        `UPDATE votes SET full_name_enc = '', constituency_enc = '',
           gender_other_enc = '', ip_hash = '', ua_hash = '', purged = 1
         WHERE created_at < ? AND purged = 0`
      ).run(cutoff);
      return Number(r.changes || 0);
    },

    async addAudit(action, detail, actor) {
      db.prepare('INSERT INTO audit (id, at, action, detail, actor) VALUES (?,?,?,?,?)')
        .run(crypto.randomUUID(), Date.now(), action, detail || '', actor || '');
    },
    async listAudit(limit = 100) {
      return db.prepare('SELECT * FROM audit ORDER BY at DESC LIMIT ?').all(limit)
        .map((r) => ({ ...r, at: num(r.at) }));
    },

    async putOtp(targetHash, codeHash, expiresAt) {
      db.prepare(
        `INSERT INTO otp_codes (target_hash, code_hash, expires_at, attempts, consumed)
         VALUES (?,?,?,0,0)
         ON CONFLICT(target_hash) DO UPDATE SET code_hash = excluded.code_hash,
           expires_at = excluded.expires_at, attempts = 0, consumed = 0`
      ).run(targetHash, codeHash, expiresAt);
    },
    async getOtp(targetHash) {
      const r = db.prepare('SELECT * FROM otp_codes WHERE target_hash = ?').get(targetHash);
      return r ? { ...r, expires_at: num(r.expires_at), attempts: num(r.attempts),
                   consumed: !!num(r.consumed) } : null;
    },
    async bumpOtpAttempts(targetHash) {
      db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE target_hash = ?')
        .run(targetHash);
    },
    async consumeOtp(targetHash) {
      db.prepare('UPDATE otp_codes SET consumed = 1 WHERE target_hash = ?').run(targetHash);
    },
  };
}

/* ---------------------------------------------------------------- Postgres */

function pgStore() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl)
      ? false : { rejectUnauthorized: false },
    // One connection per serverless container; a pool there just exhausts the
    // database's connection limit as containers multiply.
    max: config.serverless ? 1 : 10,
    idleTimeoutMillis: config.serverless ? 5000 : 30000,
  });
  const q = (text, params) => pool.query(text, params);
  const dup = (e) => e && e.code === '23505';

  return {
    kind: 'postgres',
    async init() { for (const stmt of DDL_PG) await q(stmt); },
    async close() { await pool.end(); },

    async getConfig() {
      const r = await q('SELECT * FROM poll_config WHERE id = 1');
      return mapConfig(r.rows[0]);
    },
    async setConfig(c) {
      await q(
        `INSERT INTO poll_config (id, status, opens_at, closes_at,
           publish_after_close, contact_email, updated_at)
         VALUES (1,$1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status,
           opens_at = EXCLUDED.opens_at, closes_at = EXCLUDED.closes_at,
           publish_after_close = EXCLUDED.publish_after_close,
           contact_email = EXCLUDED.contact_email, updated_at = EXCLUDED.updated_at`,
        [c.status, c.opensAt, c.closesAt,
         c.publishAfterClose ? 1 : 0, c.contactEmail || '', Date.now()]
      );
      return this.getConfig();
    },

    async insertVote(v) {
      try {
        await q(
          `INSERT INTO votes (id, voter_token_hash, phone_hash, candidate_id,
             age_bracket, gender, gender_other_enc, full_name_enc,
             constituency_enc, ip_hash, ua_hash, created_at, invalid, purged, flags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,$13)`,
          [v.id, v.voter_token_hash, v.phone_hash, v.candidate_id, v.age_bracket,
           v.gender, v.gender_other_enc, v.full_name_enc, v.constituency_enc,
           v.ip_hash, v.ua_hash, v.created_at, v.flags || '']
        );
      } catch (e) {
        if (dup(e)) { const err = new Error(DUPLICATE); err.code = DUPLICATE; throw err; }
        throw e;
      }
    },
    async listVotes() {
      const r = await q('SELECT * FROM votes ORDER BY created_at ASC');
      return r.rows.map(mapVote);
    },
    async findByToken(tokenHash) {
      const r = await q('SELECT * FROM votes WHERE voter_token_hash = $1', [tokenHash]);
      return r.rows[0] ? mapVote(r.rows[0]) : null;
    },
    async countByIpSince(ipHash, since) {
      const r = await q(
        'SELECT COUNT(*) AS n FROM votes WHERE ip_hash = $1 AND created_at >= $2',
        [ipHash, since]);
      return Number(r.rows[0].n);
    },
    async countByIp(ipHash) {
      const r = await q('SELECT COUNT(*) AS n FROM votes WHERE ip_hash = $1', [ipHash]);
      return Number(r.rows[0].n);
    },
    async setInvalid(id, invalid) {
      await q('UPDATE votes SET invalid = $1 WHERE id = $2', [invalid ? 1 : 0, id]);
    },
    async purgeOlderThan(cutoff) {
      const r = await q(
        `UPDATE votes SET full_name_enc = '', constituency_enc = '',
           gender_other_enc = '', ip_hash = '', ua_hash = '', purged = 1
         WHERE created_at < $1 AND purged = 0`, [cutoff]);
      return r.rowCount || 0;
    },

    async addAudit(action, detail, actor) {
      await q('INSERT INTO audit (id, at, action, detail, actor) VALUES ($1,$2,$3,$4,$5)',
        [crypto.randomUUID(), Date.now(), action, detail || '', actor || '']);
    },
    async listAudit(limit = 100) {
      const r = await q('SELECT * FROM audit ORDER BY at DESC LIMIT $1', [limit]);
      return r.rows.map((x) => ({ ...x, at: num(x.at) }));
    },

    async putOtp(targetHash, codeHash, expiresAt) {
      await q(
        `INSERT INTO otp_codes (target_hash, code_hash, expires_at, attempts, consumed)
         VALUES ($1,$2,$3,0,0)
         ON CONFLICT (target_hash) DO UPDATE SET code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at, attempts = 0, consumed = 0`,
        [targetHash, codeHash, expiresAt]);
    },
    async getOtp(targetHash) {
      const r = await q('SELECT * FROM otp_codes WHERE target_hash = $1', [targetHash]);
      const x = r.rows[0];
      return x ? { ...x, expires_at: num(x.expires_at), attempts: num(x.attempts),
                   consumed: !!num(x.consumed) } : null;
    },
    async bumpOtpAttempts(targetHash) {
      await q('UPDATE otp_codes SET attempts = attempts + 1 WHERE target_hash = $1',
        [targetHash]);
    },
    async consumeOtp(targetHash) {
      await q('UPDATE otp_codes SET consumed = 1 WHERE target_hash = $1', [targetHash]);
    },
  };
}

async function openStore() {
  if (config.serverless && !config.databaseUrl) {
    throw new Error(
      'A Postgres connection string is required on serverless hosts (Vercel): '
      + 'their filesystem is read-only and resets between requests, so SQLite '
      + 'would lose every vote. Add a Postgres store in your host dashboard, or '
      + 'set DATABASE_URL.'
    );
  }
  const store = config.databaseUrl ? pgStore() : sqliteStore();
  if (store.init) await store.init();
  return store;
}

module.exports = { openStore, DUPLICATE };
