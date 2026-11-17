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

const { build } = require('../src/index');

let building;

module.exports = async function handler(req, res) {
  try {
    building = building || build({ realtime: false });
    const { app } = await building;
    return app(req, res);
  } catch (e) {
    building = undefined;           // let the next request retry a cold build
    console.error('Serverless build failed:', e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      error: 'The poll service could not start. Check DATABASE_URL and the secrets.',
    }));
  }
};
