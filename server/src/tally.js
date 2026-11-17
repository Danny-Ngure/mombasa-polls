'use strict';

const { CANDIDATES, AGE_BRACKETS, GENDERS } = require('./candidates');

/**
 * Largest-remainder rounding to one decimal place, so the shares shown to
 * voters add up to exactly 100.0% instead of 99.9% or 100.1%.
 */
function shares(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => 0);
  const tenths = counts.map((c) => (c / total) * 1000);
  const out = tenths.map(Math.floor);
  const assigned = out.reduce((a, b) => a + b, 0);
  const order = tenths
    .map((v, ix) => ({ ix, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.ix - b.ix);
  for (let i = 0; i < 1000 - assigned; i++) out[order[i % order.length].ix]++;
  return out.map((v) => v / 10);
}

function groupShares(values, keys) {
  const counts = keys.map((k) => values.filter((v) => v === k).length);
  const pcts = shares(counts);
  return keys.map((k, i) => ({ label: k, pct: pcts[i] }));
}

/**
 * Build the PUBLIC results payload.
 *
 * This deliberately contains percentages only. Raw vote counts and the total
 * number of voters are never serialised here, so they cannot be recovered by
 * reading the network response or the websocket frames.
 */
function publicResults(votes) {
  const counted = votes.filter((v) => !v.invalid);
  const counts = CANDIDATES.map(
    (c) => counted.filter((v) => v.candidate_id === c.id).length
  );
  const pcts = shares(counts);

  const standings = CANDIDATES
    .map((c, i) => ({ id: c.id, name: c.name, party: c.party, pct: pcts[i] }))
    .sort((a, b) => b.pct - a.pct);

  const topPct = standings.length ? standings[0].pct : 0;
  const leaders = standings.filter((s) => s.pct === topPct && topPct > 0);

  return {
    hasVotes: counted.length > 0,
    standings,
    leader: leaders.length === 1 ? leaders[0] : null,
    tiedLeaders: leaders.length > 1 ? leaders : null,
    demographics: {
      age: groupShares(counted.map((v) => v.age_bracket), AGE_BRACKETS),
      gender: groupShares(counted.map((v) => v.gender), GENDERS),
    },
    updatedAt: Date.now(),
  };
}

/** Admin-only figures. Never sent to the public endpoints. */
function adminTotals(votes) {
  const counted = votes.filter((v) => !v.invalid);
  return {
    total: votes.length,
    counted: counted.length,
    invalid: votes.length - counted.length,
    perCandidate: CANDIDATES.map((c) => ({
      id: c.id,
      name: c.name,
      count: counted.filter((v) => v.candidate_id === c.id).length,
    })),
  };
}

module.exports = { shares, publicResults, adminTotals, groupShares, GENDERS, AGE_BRACKETS };
