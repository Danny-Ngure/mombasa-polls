'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./config');
const store0 = require('./store');
const otp = require('./otp');
const C = require('./candidates');
const { publicResults, adminTotals } = require('./tally');
const {
  encrypt, decrypt, hash, shortRef, randomToken,
  sign, unsign, parseCookies, verifyPassword, isValidStoredHash, safeEqual,
} = require('./crypto');

const VOTER_COOKIE = 'mnyp_voter';
const ADMIN_COOKIE = 'mnyp_admin';
const OTP_COOKIE = 'mnyp_otp';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Builds the app. `realtime: false` (serverless hosts such as Vercel, which
 * cannot hold a websocket open) skips Socket.IO and the background timers;
 * the browser then polls /api/results instead. Everything else is identical.
 */
async function build(opts) {
  const realtime = !(opts && opts.realtime === false);
  const store = await store0.openStore();

  // Replaced with the real Socket.IO server below when realtime is on. Routes
  // close over this variable, so reassigning it later is enough.
  let io = { to: () => ({ emit() {} }), emit() {}, on() {} };

  /* ---------------------------------------------------------- helpers */

  async function readConfig() {
    let c = await store.getConfig();
    if (!c) {
      c = await store.setConfig({
        status: 'idle', opensAt: null, closesAt: null,
        publishAfterClose: false, contactEmail: '',
      });
    }
    return c;
  }

  function phaseOf(c) {
    if (config.forceClosed) return 'closed';        // blueprint kill switch
    if (!c || !c.status || c.status === 'idle') return 'idle';
    if (c.status === 'closed') return 'closed';
    if (c.closesAt && Date.now() >= c.closesAt) return 'closed';  // optional deadline
    if (c.opensAt && Date.now() < c.opensAt) return 'idle';
    return 'open';
  }

  const clientIp = (req) =>
    (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  function voterTokenFrom(reqOrHeaders) {
    const header = reqOrHeaders.headers
      ? reqOrHeaders.headers.cookie : reqOrHeaders.cookie;
    const raw = parseCookies(header)[VOTER_COOKIE];
    return raw ? unsign(raw) : null;
  }

  function setCookie(res, name, value, maxAgeMs) {
    res.cookie(name, sign(value), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: maxAgeMs,
      path: '/',
    });
  }

  async function hasVoted(token) {
    if (!token) return false;
    return !!(await store.findByToken(hash(token)));
  }

  function isAdmin(req) {
    const raw = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    const v = raw ? unsign(raw) : null;
    if (!v) return false;
    const [user, issued] = v.split('|');
    if (!user || !issued) return false;
    if (Date.now() - Number(issued) > 12 * 60 * 60 * 1000) return false;
    return user === config.adminUser;
  }

  /* --------------------------------------------------- simple rate limit */

  const buckets = new Map();
  function recent(key, windowMs) {
    const now = Date.now();
    const list = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    buckets.set(key, list);
    return list;
  }
  /** Check the budget WITHOUT spending it. */
  function rateLimitPeek(key, max, windowMs) {
    return recent(key, windowMs).length < max;
  }
  /** Spend one unit of the budget. */
  function rateLimitHit(key, windowMs) {
    recent(key, windowMs).push(Date.now());
  }
  /** Peek and spend in one go - for endpoints where every call counts. */
  function rateLimit(key, max, windowMs) {
    if (!rateLimitPeek(key, max, windowMs)) return false;
    rateLimitHit(key, windowMs);
    return true;
  }
  if (realtime) {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of buckets) {
        const keep = v.filter((t) => now - t < 60 * 60 * 1000);
        if (keep.length) buckets.set(k, keep); else buckets.delete(k);
      }
    }, 10 * 60 * 1000).unref();
  }

  /* ---------------------------------------------------------- captcha */

  async function captchaOk(token, ip) {
    if (!config.captchaEnabled) return true;
    if (!token) return false;
    try {
      const res = await fetch('https://api.hcaptcha.com/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: config.hcaptchaSecret, response: token, remoteip: ip,
        }),
      });
      const j = await res.json();
      return !!j.success;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------- app */

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '16kb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "script-src 'self' https://hcaptcha.com https://*.hcaptcha.com",
      "frame-src https://hcaptcha.com https://*.hcaptcha.com",
      "connect-src 'self' https://hcaptcha.com https://*.hcaptcha.com",
      "form-action 'self'",
      "base-uri 'self'",
    ].join('; '));
    next();
  });

  // Reject cross-site state-changing requests.
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      const host = req.get('host');
      let ok = false;
      try { ok = new URL(origin).host === host; } catch { ok = false; }
      if (!ok) return res.status(403).json({ error: 'Cross-site request refused.' });
    }
    return next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.isProd ? '1h' : 0,
    index: 'index.html',
  }));

  // /admin is the address people are given; serve the page there as well as at
  // its filename, so a typed URL without the extension does not 404.
  app.get(['/admin', '/admin/'], (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

  /* -------------------------------------------------------- public API */

  app.get('/api/config', async (req, res) => {
    let token = voterTokenFrom(req);
    if (!token) {
      token = randomToken(24);
      setCookie(res, VOTER_COOKIE, token, 45 * DAY_MS);
    }
    const cfg = await readConfig();
    const voted = await hasVoted(token);
    res.json({
      candidates: C.CANDIDATES,
      ageBrackets: C.AGE_BRACKETS,
      genders: C.GENDERS,
      constituencies: C.CONSTITUENCIES,
      poll: {
        phase: phaseOf(cfg),
        opensAt: cfg.opensAt,
        closesAt: cfg.closesAt,
        publishAfterClose: cfg.publishAfterClose,
        contactEmail: cfg.contactEmail,
      },
      voted,
      isAdmin: isAdmin(req),
      otpRequired: config.otpEnabled,
      captchaSiteKey: config.captchaEnabled ? config.hcaptchaSiteKey : '',
    });
  });

  async function maySeeResults(req) {
    if (isAdmin(req)) return true;
    if (await hasVoted(voterTokenFrom(req))) return true;
    const cfg = await readConfig();
    return phaseOf(cfg) === 'closed' && cfg.publishAfterClose;
  }

  app.get('/api/results', async (req, res) => {
    if (!(await maySeeResults(req))) {
      return res.status(403).json({ error: 'Results are available after you vote.' });
    }
    res.json(publicResults(await store.listVotes()));
  });

  app.post('/api/otp/request', async (req, res) => {
    if (!config.otpEnabled) return res.status(400).json({ error: 'Verification is not enabled.' });
    if (!rateLimit(`otp:${clientIp(req)}`, 5, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    const r = await otp.request(store, req.body && req.body.phone);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  });

  app.post('/api/otp/verify', async (req, res) => {
    if (!config.otpEnabled) return res.status(400).json({ error: 'Verification is not enabled.' });
    if (!rateLimit(`otpv:${clientIp(req)}`, 10, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
    }
    const r = await otp.verify(store, req.body && req.body.phone, req.body && req.body.code);
    if (!r.ok) return res.status(400).json({ error: r.error });
    setCookie(res, OTP_COOKIE, r.phoneHash, 60 * 60 * 1000);
    res.json({ ok: true });
  });

  app.post('/api/vote', async (req, res) => {
    const ip = clientIp(req);
    const ipHash = hash(`ip:${ip}`);

    // Successful votes are budgeted separately from attempts, so a voter who
    // mistypes the form is never locked out by their own corrections.
    if (!rateLimitPeek(`vote:${ip}`, config.rateLimitMaxVotes, config.rateLimitWindowMs)) {
      return res.status(429).json({ error: 'Too many votes from this connection.' });
    }
    if (!rateLimit(`voteattempt:${ip}`, 40, config.rateLimitWindowMs)) {
      return res.status(429).json({ error: 'Too many attempts from this connection.' });
    }

    const cfg = await readConfig();
    if (phaseOf(cfg) !== 'open') {
      return res.status(409).json({ error: 'Voting is not open.' });
    }

    let token = voterTokenFrom(req);
    if (!token) {
      token = randomToken(24);
      setCookie(res, VOTER_COOKIE, token, 45 * DAY_MS);
    }
    const tokenHash = hash(token);
    if (await store.findByToken(tokenHash)) {
      return res.status(409).json({ error: 'A vote has already been cast from this device.' });
    }

    const b = req.body || {};
    const fullName = String(b.fullName || '').trim();
    const ageBracket = String(b.ageBracket || '');
    const constituency = String(b.constituency || '');
    const gender = String(b.gender || '');
    const genderOther = String(b.genderOther || '').trim();
    const candidateId = String(b.candidateId || '');

    const bad = (m) => res.status(400).json({ error: m });
    if (fullName.length < 2 || fullName.length > 80) return bad('Please enter your full name.');
    if (!C.AGE_BRACKETS.includes(ageBracket)) return bad('Please choose an age bracket.');
    if (!C.CONSTITUENCIES.includes(constituency)) return bad('Please choose a constituency.');
    if (!C.GENDERS.includes(gender)) return bad('Please choose a gender option.');
    if (!C.CANDIDATE_IDS.includes(candidateId)) return bad('Please select a candidate.');

    if (!(await captchaOk(b.captchaToken, ip))) {
      return res.status(400).json({ error: 'Please complete the verification challenge.' });
    }

    let phoneHash = null;
    if (config.otpEnabled) {
      const raw = parseCookies(req.headers.cookie)[OTP_COOKIE];
      phoneHash = raw ? unsign(raw) : null;
      if (!phoneHash) {
        return res.status(403).json({ error: 'Verify your phone number before voting.' });
      }
    }

    // Soft anti-fraud signals: recorded for admin review, never auto-rejected.
    const flags = [];
    if (await store.countByIp(ipHash) >= config.maxVotesPerIp) {
      return res.status(429).json({ error: 'Too many votes from this network.' });
    }
    if (await store.countByIpSince(ipHash, Date.now() - 60 * 60 * 1000) >= 3) {
      flags.push('repeat-ip');
    }
    if (!req.get('user-agent')) flags.push('no-user-agent');

    try {
      await store.insertVote({
        id: crypto.randomUUID(),
        voter_token_hash: tokenHash,
        phone_hash: phoneHash,
        candidate_id: candidateId,
        age_bracket: ageBracket,
        gender,
        gender_other_enc: encrypt(genderOther),
        full_name_enc: encrypt(fullName),
        constituency_enc: encrypt(constituency),
        ip_hash: ipHash,
        ua_hash: hash(`ua:${req.get('user-agent') || ''}`),
        created_at: Date.now(),
        flags: flags.join(','),
      });
    } catch (e) {
      if (e.code === store0.DUPLICATE) {
        return res.status(409).json({ error: 'A vote has already been recorded for you.' });
      }
      console.error('vote insert failed', e);
      return res.status(500).json({ error: 'Could not record your vote. Please try again.' });
    }

    rateLimitHit(`vote:${ip}`, config.rateLimitWindowMs);

    const results = publicResults(await store.listVotes());
    io.to('voters').emit('results', results);
    io.to('admins').emit('admin:dirty', { at: Date.now() });
    res.json({ ok: true, results });
  });

  /* --------------------------------------------------------- admin API */

  app.post('/api/admin/login', async (req, res) => {
    const ip = clientIp(req);
    if (!rateLimit(`login:${ip}`, 8, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    const { username, password } = req.body || {};
    const userOk = safeEqual(String(username || ''), config.adminUser);
    /* Use the hash only when it is actually usable. A truncated or mangled
       hash previously took precedence and locked the panel even though a
       valid ADMIN_PASSWORD was configured alongside it. */
    const passOk = isValidStoredHash(config.adminPasswordHash)
      ? verifyPassword(String(password || ''), config.adminPasswordHash)
      : (!!config.adminPasswordPlain
         && safeEqual(String(password || ''), config.adminPasswordPlain));
    if (!userOk || !passOk) {
      await store.addAudit('Failed admin login', `from ${shortRef(ip)}`, '-');
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }
    setCookie(res, ADMIN_COOKIE, `${config.adminUser}|${Date.now()}`, 12 * 60 * 60 * 1000);
    await store.addAudit('Admin signed in', `from ${shortRef(ip)}`, config.adminUser);
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    res.clearCookie(ADMIN_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  function requireAdmin(req, res, next) {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Administrator sign-in required.' });
    return next();
  }

  app.get('/api/admin/state', requireAdmin, async (req, res) => {
    const votes = await store.listVotes();
    const cfg = await readConfig();
    res.json({
      poll: { ...cfg, phase: phaseOf(cfg) },
      totals: adminTotals(votes),
      submissions: votes.map((v) => ({
        id: v.id,
        createdAt: v.created_at,
        fullName: v.purged ? '[purged]' : decrypt(v.full_name_enc),
        constituency: v.purged ? '[purged]' : decrypt(v.constituency_enc),
        ageBracket: v.age_bracket,
        gender: v.gender,
        genderOther: v.purged ? '' : decrypt(v.gender_other_enc),
        candidate: (C.byId(v.candidate_id) || {}).name || v.candidate_id,
        party: (C.byId(v.candidate_id) || {}).party || '',
        voterRef: v.voter_token_hash.slice(0, 8).toUpperCase(),
        invalid: v.invalid,
        purged: v.purged,
        flags: v.flags ? v.flags.split(',') : [],
      })),
      audit: await store.listAudit(100),
      retentionDays: config.retentionDays,
      otpEnabled: config.otpEnabled,
      captchaEnabled: config.captchaEnabled,
    });
  });

  app.post('/api/admin/poll', requireAdmin, async (req, res) => {
    const action = String((req.body || {}).action || '');
    const cfg = await readConfig();
    const now = Date.now();
    let next;

    if (action === 'start') {
      // No closing time: the poll runs until an administrator closes it.
      // Set POLL_HOURS and use the 'extend' action if you want a deadline.
      next = { ...cfg, status: 'open', opensAt: now, closesAt: null };
      await store.addAudit('Poll opened', 'Voting opened with no closing time',
        config.adminUser);
    } else if (action === 'close') {
      next = { ...cfg, status: 'closed', closesAt: now };
      await store.addAudit('Poll closed', 'Closed manually', config.adminUser);
    } else if (action === 'extend') {
      const hours = Math.max(1, Math.min(168, Number((req.body || {}).hours) || 6));
      const base = Math.max(now, cfg.closesAt || now);
      next = { ...cfg, status: 'open', closesAt: base + hours * 60 * 60 * 1000 };
      await store.addAudit('Poll extended', `+${hours} hours`, config.adminUser);
    } else {
      return res.status(400).json({ error: 'Unknown action.' });
    }

    const saved = await store.setConfig(next);
    io.emit('poll', { phase: phaseOf(saved), opensAt: saved.opensAt, closesAt: saved.closesAt,
                      publishAfterClose: saved.publishAfterClose });
    res.json({ ok: true, poll: { ...saved, phase: phaseOf(saved) } });
  });

  app.post('/api/admin/settings', requireAdmin, async (req, res) => {
    const cfg = await readConfig();
    const body = req.body || {};
    const saved = await store.setConfig({
      ...cfg,
      publishAfterClose: !!body.publishAfterClose,
      contactEmail: String(body.contactEmail || '').slice(0, 120),
    });
    await store.addAudit('Settings updated', 'Publication and contact settings',
      config.adminUser);
    io.emit('poll', { phase: phaseOf(saved), opensAt: saved.opensAt, closesAt: saved.closesAt,
                      publishAfterClose: saved.publishAfterClose });
    res.json({ ok: true, poll: { ...saved, phase: phaseOf(saved) } });
  });

  app.post('/api/admin/vote/:id/invalid', requireAdmin, async (req, res) => {
    const invalid = !!(req.body || {}).invalid;
    await store.setInvalid(req.params.id, invalid);
    await store.addAudit(invalid ? 'Vote marked invalid' : 'Vote restored',
      `Vote ${String(req.params.id).slice(0, 8)}`, config.adminUser);
    const results = publicResults(await store.listVotes());
    io.to('voters').emit('results', results);
    res.json({ ok: true });
  });

  app.get('/api/admin/export.csv', requireAdmin, async (req, res) => {
    const votes = await store.listVotes();
    const cell = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['Submitted At', 'Full Name', 'Age Bracket',
      'Constituency (hidden publicly)', 'Gender', 'Gender (self-described)',
      'Candidate', 'Party', 'Status', 'Verification', 'Voter Ref', 'Flags'];
    const lines = [head.map(cell).join(',')];
    for (const v of votes) {
      const c = C.byId(v.candidate_id) || {};
      lines.push([
        new Date(v.created_at).toISOString(),
        v.purged ? '[purged]' : decrypt(v.full_name_enc),
        v.age_bracket,
        v.purged ? '[purged]' : decrypt(v.constituency_enc),
        v.gender,
        v.purged ? '' : decrypt(v.gender_other_enc),
        c.name || v.candidate_id,
        c.party || '',
        v.invalid ? 'Invalid' : 'Counted',
        v.phone_hash ? 'Phone OTP verified' : 'Unverified',
        v.voter_token_hash.slice(0, 8).toUpperCase(),
        v.flags,
      ].map(cell).join(','));
    }
    await store.addAudit('CSV exported', `${votes.length} submissions`, config.adminUser);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      'attachment; filename="mombasa-ni-yetu-polls-submissions.csv"');
    res.send(`﻿${lines.join('\r\n')}`);
  });

  app.post('/api/admin/purge', requireAdmin, async (req, res) => {
    const cutoff = Date.now() - config.retentionDays * DAY_MS;
    const n = await store.purgeOlderThan(cutoff);
    await store.addAudit('Retention purge',
      `${n} submissions anonymised (older than ${config.retentionDays} days)`,
      config.adminUser);
    res.json({ ok: true, purged: n });
  });

  /* Health plus enough configuration shape to diagnose a bad deploy without
     revealing anything secret: whether the admin hash is present and
     well-formed, never the hash itself. */
  app.get('/healthz', (req, res) => res.json({
    ok: true,
    storage: store.kind,
    adminHash: {
      present: !!config.adminPasswordHash,
      length: config.adminPasswordHash.length,
      wellFormed: isValidStoredHash(config.adminPasswordHash),
    },
    // Which credential the login route will actually use.
    adminAuth: isValidStoredHash(config.adminPasswordHash) ? 'hash'
      : (config.adminPasswordPlain ? 'password' : 'NONE - cannot sign in'),
    forceClosed: config.forceClosed,
  }));

  /* ------------------------------------------------------------ server */

  let server = null;
  if (realtime) {
  server = http.createServer(app);
  io = new Server(server, { cors: { origin: false } });

  io.on('connection', async (socket) => {
    const token = voterTokenFrom(socket.handshake);
    const admin = (() => {
      const raw = parseCookies(socket.handshake.headers.cookie)[ADMIN_COOKIE];
      const v = raw ? unsign(raw) : null;
      return !!v && v.split('|')[0] === config.adminUser;
    })();

    const cfg = await readConfig();
    socket.emit('poll', { phase: phaseOf(cfg), opensAt: cfg.opensAt,
                          closesAt: cfg.closesAt, publishAfterClose: cfg.publishAfterClose });

    const allowed = admin || (await hasVoted(token))
      || (phaseOf(cfg) === 'closed' && cfg.publishAfterClose);
    if (allowed) {
      socket.join('voters');
      socket.emit('results', publicResults(await store.listVotes()));
    }
    if (admin) socket.join('admins');
  });

  // Close the poll exactly on time for everyone watching.
  setInterval(async () => {
    const cfg = await readConfig();
    if (cfg.status === 'open' && cfg.closesAt && Date.now() >= cfg.closesAt) {   // only when a deadline was set
      const saved = await store.setConfig({ ...cfg, status: 'closed' });
      await store.addAudit('Poll closed', 'Scheduled end of the voting window', 'system');
      io.emit('poll', { phase: 'closed', opensAt: saved.opensAt, closesAt: saved.closesAt,
                        publishAfterClose: saved.publishAfterClose });
    }
  }, 15 * 1000).unref();
  }

  if (config.autoStart) {
    const cfg = await readConfig();
    if (phaseOf(cfg) === 'idle') {
      await store.setConfig({ ...cfg, status: 'open', opensAt: Date.now(), closesAt: null });
      await store.addAudit('Poll opened', 'AUTO_START_POLL on first boot', 'system');
    }
  }

  return { app, server, store };
}

module.exports = { build };

/* Started directly (local, Render, Docker): listen with realtime enabled. */
if (require.main === module) {
  build({ realtime: true }).then(({ server, store }) => {
    server.listen(config.port, () => {
      console.log(`Mombasa Ni Yetu Polls listening on :${config.port} (${store.kind})`);
      if (!config.isProd) {
        console.log(`Admin sign-in: ${config.adminUser} / ${config.adminPasswordPlain}`);
      }
    });
  }).catch((e) => {
    console.error('Startup failed:', e.message);
    process.exit(1);
  });
}
