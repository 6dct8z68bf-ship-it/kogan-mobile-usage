'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny .env reader with no external dependencies.
 * Supports KEY=VALUE, # comments and single or double quoted values.
 */
function parseEnvFile(content) {
  const out = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Read a .env file; a missing file yields an empty object. */
function loadEnv(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseEnvFile(content);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

/** Phone numbers are compared without spaces or dashes. */
function normaliseMsisdn(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[\s-]/g, '').trim();
}

/**
 * Optional owner names, keyed by phone number. Both forms work:
 *   KOGAN_OWNERS=0400000001:Alice,0400000002:Bob
 *   KOGAN_NAME_1=Alice      (paired with KOGAN_MSISDN_1 / KOGAN_PIN_1)
 */
function collectOwnerMap(env) {
  const owners = new Map();
  const list = env.KOGAN_OWNERS || env.KOGAN_NAMES || '';

  for (const entry of String(list).split(/[,\n;]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const msisdn = normaliseMsisdn(trimmed.slice(0, idx));
    const name = trimmed.slice(idx + 1).trim();
    if (msisdn && name) owners.set(msisdn, name);
  }

  for (let i = 1; i <= 50; i += 1) {
    const msisdn = normaliseMsisdn(env[`KOGAN_MSISDN_${i}`] || env[`KOGAN_ACCOUNT_${i}`] || '');
    const name = String(env[`KOGAN_NAME_${i}`] || '').trim();
    if (msisdn && name && !owners.has(msisdn)) owners.set(msisdn, name);
  }

  return owners;
}

/**
 * Collect the account list from the environment.
 * Both forms are supported and may be mixed:
 *   KOGAN_ACCOUNTS=0400000000:123456,0455555555:654321
 *   KOGAN_ACCOUNTS=0400000000:123456:Alice          (optional owner name)
 *   KOGAN_MSISDN_1=0400000000 + KOGAN_PIN_1=123456
 * Duplicate phone numbers are dropped.
 */
function collectAccounts(env) {
  const accounts = [];
  const seen = new Set();
  const owners = collectOwnerMap(env);

  const push = (msisdn, pin, name, source) => {
    const mobile = normaliseMsisdn(msisdn);
    const code = String(pin === null || pin === undefined ? '' : pin).trim();
    if (!mobile || !code) return;
    const key = `${mobile}:${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    const owner = (name && String(name).trim()) || owners.get(mobile) || null;
    accounts.push({ msisdn: mobile, pin: code, name: owner, source });
  };

  const list = env.KOGAN_ACCOUNTS || env.KOGAN_ACCOUNT || '';
  for (const entry of String(list).split(/[,\n;]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    if (parts.length === 1) {
      // A bare phone number reuses the shared KOGAN_PIN value.
      push(parts[0], env.KOGAN_PIN, null, 'KOGAN_ACCOUNTS');
      continue;
    }
    // phone:pin, or phone:pin:Owner name (a name may itself contain colons).
    const name = parts.length > 2 ? parts.slice(2).join(':') : null;
    push(parts[0], parts[1], name, 'KOGAN_ACCOUNTS');
  }

  for (let i = 1; i <= 50; i += 1) {
    const msisdn = env[`KOGAN_MSISDN_${i}`] || env[`KOGAN_ACCOUNT_${i}`];
    const pin = env[`KOGAN_PIN_${i}`];
    if (msisdn) push(msisdn, pin, null, `KOGAN_MSISDN_${i}`);
  }

  if (accounts.length === 0 && env.KOGAN_MSISDN && env.KOGAN_PIN) {
    push(env.KOGAN_MSISDN, env.KOGAN_PIN, null, 'KOGAN_MSISDN');
  }

  return accounts;
}

function resolveEnvPath(cwd, explicit) {
  if (explicit) return path.resolve(cwd, explicit);
  return path.join(cwd, '.env');
}

module.exports = { parseEnvFile, loadEnv, collectAccounts, collectOwnerMap, normaliseMsisdn, resolveEnvPath };
