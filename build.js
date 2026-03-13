/**
 * build.js — Voyagr token injection
 *
 * Reads MAPBOX_TOKEN from .env (or environment), then writes
 * script.js in-place with the placeholder replaced.
 *
 * A backup is kept at script.js.bak so you can restore the
 * placeholder any time (and it's what actually lives in git).
 *
 * Usage:
 *   node build.js            — inject token (run before opening app)
 *   node build.js --restore  — restore placeholder (before git commit)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SCRIPT     = path.join(__dirname, 'script.js');
const SCRIPT_BAK = path.join(__dirname, 'script.js.bak');
const PLACEHOLDER = '%%MAPBOX_TOKEN%%';

// ── --restore mode: put the placeholder back ──────────────────
if (process.argv.includes('--restore')) {
  if (!fs.existsSync(SCRIPT_BAK)) {
    console.error('❌  script.js.bak not found — nothing to restore.');
    process.exit(1);
  }
  fs.copyFileSync(SCRIPT_BAK, SCRIPT);
  fs.unlinkSync(SCRIPT_BAK);
  console.log('✅  script.js restored to placeholder. Safe to commit.');
  process.exit(0);
}

// ── Load .env ─────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq  = trimmed.indexOf('=');
      if (eq < 0) return;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      process.env[key] = val;
    });
  console.log('✅  Loaded .env');
} else {
  console.warn('⚠️   No .env file found. Using existing environment variables.');
}

// ── Read token ────────────────────────────────────────────────
const token = (process.env.MAPBOX_TOKEN || '').trim();

if (!token) {
  console.error('❌  MAPBOX_TOKEN is empty or not set.');
  console.error('    Check your .env file has: MAPBOX_TOKEN=pk.eyJ1...');
  process.exit(1);
}

console.log(`🔑  Token loaded: ${token.slice(0, 12)}…${token.slice(-6)}`);

// ── Read script.js ────────────────────────────────────────────
const original = fs.readFileSync(SCRIPT, 'utf8');

// If it has already been injected (no placeholder), stop
if (!original.includes(PLACEHOLDER)) {
  // Check if it already has a real token value
  if (original.match(/MAPBOX_TOKEN\s*=\s*'[a-zA-Z0-9_.]+'/)) {
    console.log('ℹ️   script.js already has a token injected. To re-inject, run:');
    console.log('    node build.js --restore   then   node build.js');
  } else {
    console.error(`❌  Placeholder "${PLACEHOLDER}" not found in script.js.`);
  }
  process.exit(0);
}

// ── Backup original (placeholder version) ────────────────────
fs.copyFileSync(SCRIPT, SCRIPT_BAK);
console.log('💾  Backed up placeholder version → script.js.bak');

// ── Inject token ──────────────────────────────────────────────
const injected = original.replace(new RegExp(PLACEHOLDER, 'g'), token);
fs.writeFileSync(SCRIPT, injected, 'utf8');

console.log('✅  Token injected into script.js');
console.log('');
console.log('   Open index.html with Live Server — Mapbox is now active.');
console.log('');
console.log('   Before committing to git, ALWAYS run:');
console.log('   node build.js --restore');
