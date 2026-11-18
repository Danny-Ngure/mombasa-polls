'use strict';

/**
 * Vercel serverless entry point.
 *
 * Vercel cannot hold a websocket open, so the app is built with realtime off
 * and the browser polls /api/results instead. Everything else - voting, the
 * one-vote rule, encryption, the admin panel - is the same code path as the
 * long-running server in src/index.js.
 *
 * The built app is cached per warm container so the database pool and schema
 * setup are not repeated on every request.
 */

let building;

module.exports = async function handler(req, res) {
  try {
    // Required lazily: config throws when a secret is absent, and at module
    // scope that crashes the function before this handler can explain why.
    if (!building) {
      const { build } = require('../src/index');
      building = build({ realtime: false });
    }
    const { app } = await building;
    return app(req, res);
  } catch (e) {
    building = undefined;           // let the next request retry a cold build
    console.error('Startup failed:', e && e.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({
      error: 'The poll service is not configured yet.',
      detail: (e && e.message) || String(e),
    }, null, 2));
  }
};
