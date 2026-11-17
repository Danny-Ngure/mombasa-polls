#!/usr/bin/env node
'use strict';

/* Retention purge. Destroys names, constituencies, IP and device hashes for
   submissions older than RETENTION_DAYS, keeping the anonymous tally intact.
   Run on a schedule (cron / Render Cron Job):  npm run purge               */

const config = require('../src/config');
const { openStore } = require('../src/store');

(async () => {
  const store = await openStore();
  const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
  const n = await store.purgeOlderThan(cutoff);
  await store.addAudit('Retention purge',
    `${n} submissions anonymised (older than ${config.retentionDays} days)`, 'cron');
  console.log(`Anonymised ${n} submission(s) older than ${config.retentionDays} days.`);
  await store.close();
})().catch((e) => { console.error(e); process.exit(1); });
