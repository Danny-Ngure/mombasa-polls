#!/usr/bin/env node
'use strict';

/* Generates the secrets the poll needs in production.
   Usage:  npm run keys -- "YourAdminPassword"                               */

const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

const password = process.argv[2];
const rnd = () => crypto.randomBytes(32).toString('hex');

console.log('\n# ---- Paste these into your host\'s environment variables ----\n');
console.log(`DATA_ENCRYPTION_KEY=${rnd()}`);
console.log(`COOKIE_SECRET=${rnd()}`);
console.log(`HASH_PEPPER=${rnd()}`);

if (password) {
  console.log(`ADMIN_USER=admin`);
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
  console.log('\n# Sign in at /admin with the password you just passed in.');
} else {
  console.log('\n# No admin password given. Re-run with one to get ADMIN_PASSWORD_HASH:');
  console.log('#   npm run keys -- "YourStrongPassword"');
}

console.log('\n# Keep these secret. Changing DATA_ENCRYPTION_KEY makes existing');
console.log('# voter names and constituencies permanently unreadable.\n');
