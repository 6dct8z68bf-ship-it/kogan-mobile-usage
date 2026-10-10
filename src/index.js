#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { loadEnv, collectAccounts, resolveEnvPath } = require('./env');
const { parseUsageHtml } = require('./parse-usage');
const { cleanUsage } = require('./clean-usage');
const { renderReport } = require('./render-report');
const { fetchUsageForAccount, KoganError, maskMsisdn } = require('./kogan-client');
const { createTranslator, usageText, normalizeLang, DEFAULT_LANG } = require('./i18n');

const TYPE_MAP = {
  all: 'All',
  data: 'Data',
  smsms: 'SMSMMS',
  sms: 'SMSMMS',
  mms: 'SMSMMS',
  calls: 'Calls',
  voice: 'Calls',
};

const VALUE_FLAGS = new Set([
  'fixture',
  'html',
  'env',
  'months',
  'type',
  'min-mb',
  'highlight-mb',
  'mb-base',
  'lang',
  'out',
  'save-raw',
]);

/** Command line errors carry a message key so they can be translated later. */
class CliError extends Error {
  constructor(key, args) {
    super(key);
    this.name = 'CliError';
    this.key = key;
    this.args = args || [];
  }
}

function parseArgs(argv) {
  const options = {
    fixtures: [],
    values: {},
    help: false,
    open: false,
    saveRaw: true,
    redact: false,
    hideNames: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token === '-h' || token === '--help') {
      options.help = true;
      continue;
    }
    if (token === '--open') {
      options.open = true;
      continue;
    }
    if (token === '--no-save-raw') {
      options.saveRaw = false;
      continue;
    }
    if (token === '--redact') {
      options.redact = true;
      continue;
    }
    if (token === '--hide-names') {
      options.hideNames = true;
      continue;
    }
    if (token === '-f') {
      options.fixtures.push(argv[(i += 1)]);
      continue;
    }
    if (token === '-o') {
      options.values.out = argv[(i += 1)];
      continue;
    }

    if (token.startsWith('--')) {
      let key = token.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (key === 'fixture' || key === 'html') {
        options.fixtures.push(value !== undefined ? value : argv[(i += 1)]);
        continue;
      }
      if (!VALUE_FLAGS.has(key)) {
        throw new CliError('unknownOption', [token]);
      }
      if (value === undefined) {
        value = argv[(i += 1)];
      }
      options.values[key] = value;
      continue;
    }

    positional.push(token);
  }

  if (positional.length && options.fixtures.length === 0) options.fixtures.push(...positional);
  return options;
}

/** CLI value wins over the .env value, which wins over the built-in default. */
function pick(cliValue, envValue, fallback) {
  if (cliValue !== undefined && cliValue !== null && cliValue !== '') return cliValue;
  if (envValue !== undefined && envValue !== null && envValue !== '') return envValue;
  return fallback;
}

function toPositiveNumber(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new CliError('invalidNumber', [label, value]);
  }
  return n;
}

function normaliseMonths(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  // The website only offers Month (1), 3 Months (3) and 6 Months (6).
  if (![1, 3, 6].includes(n)) {
    throw new CliError('invalidMonths', [value]);
  }
  return n;
}

function normaliseType(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  return TYPE_MAP[raw.toLowerCase()] || raw;
}

/** Accepts the usual spellings for a boolean setting. */
function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value === undefined || value === null ? '' : value).trim().toLowerCase());
}

/** Timestamp of "now" in the account's timezone (Australia/Sydney). */
function formatNowSydney(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (Australia/Sydney)`;
}

function fileStamp(date = new Date()) {
  return formatNowSydney(date).replace(/[^0-9]/g, '').slice(0, 12);
}

/** Turn a phone number or label into a safe file name / HTML id fragment. */
function safeSlug(value) {
  return String(value || '')
    .replace(/[^0-9a-zA-Z]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Open the report in the default browser.
 * detached + stdio "ignore" keeps the child from holding the CLI's stdout,
 * which would otherwise keep the process (or a pipe) alive.
 */
function openFile(filePath) {
  const abs = path.resolve(filePath);
  const isWindows = process.platform === 'win32';
  const command = isWindows ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const commandArgs = isWindows ? ['/c', 'start', '', abs] : [abs];
  try {
    const child = execFile(command, commandArgs, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* failing to open a browser must not affect the generated report */
  }
}

function analyseParsed(parsed, settings, scope) {
  const analysis = cleanUsage(parsed, {
    mbBase: settings.mbBase,
    minMb: settings.minMb,
    highlightMb: settings.highlightMb,
  });
  analysis.scope = scope;
  analysis.months = settings.months;
  analysis.type = settings.type;
  return analysis;
}

/** Translate a parser failure code into a human readable message. */
function parseErrorMessage(t, parsed) {
  if (parsed.error === 'TABLE_NOT_FOUND') {
    return t('parseTableNotFound', parsed.tableId || 'service-usage-history');
  }
  if (parsed.error === 'NOT_LOGGED_IN') return t('parseNotLoggedIn');
  return parsed.message;
}

/** Two accounts can share a label; append a counter so HTML ids stay unique. */
function makeScopeFactory() {
  const used = new Set();
  return (base) => {
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    used.add(candidate);
    return candidate;
  };
}

/**
 * HTML id for one account section.
 *
 * The scope ends up in ids, anchors and data attributes, so a redacted report
 * has to use a neutral value; otherwise the phone number leaks even though the
 * visible label was replaced.
 */
function accountScope(settings, position, source, uniqueScope) {
  if (settings.redact) return `account-${position}`;
  return uniqueScope(safeSlug(source) || `account-${position}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();

  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    const t = createTranslator(process.env.KOGAN_LANG);
    log(t('unknownOption', err.args && err.args.length ? err.args[0] : err.message));
    log(usageText(t.lang));
    process.exitCode = 1;
    return;
  }

  const envPath = resolveEnvPath(cwd, options.values.env);
  const env = loadEnv(envPath);
  const lang = normalizeLang(pick(options.values.lang, env.KOGAN_LANG, DEFAULT_LANG)) || DEFAULT_LANG;
  const t = createTranslator(lang);

  if (options.help) {
    log(usageText(lang));
    return;
  }

  let settings;
  try {
    settings = {
      lang,
      redact: options.redact || isTruthy(env.KOGAN_REDACT),
      hideNames: options.hideNames || isTruthy(env.KOGAN_HIDE_NAMES),
      months: normaliseMonths(pick(options.values.months, env.KOGAN_MONTHS, 1), 1),
      type: normaliseType(pick(options.values.type, env.KOGAN_USAGE_TYPE, 'Data'), 'Data'),
      minMb: toPositiveNumber(pick(options.values['min-mb'], env.KOGAN_MIN_MB, 1), 1, '--min-mb'),
      highlightMb: toPositiveNumber(
        pick(options.values['highlight-mb'], env.KOGAN_HIGHLIGHT_MB, 50),
        50,
        '--highlight-mb'
      ),
      mbBase: toPositiveNumber(pick(options.values['mb-base'], env.KOGAN_MB_BASE, 1048576), 1048576, '--mb-base'),
    };
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    log(t(err.key, ...err.args));
    process.exitCode = 1;
    return;
  }

  const outFile = path.resolve(cwd, pick(options.values.out, env.KOGAN_OUT_FILE, 'out/usage-report.html'));
  const rawDir = path.resolve(cwd, pick(options.values['save-raw'], env.KOGAN_RAW_DIR, 'out/raw'));

  const analyses = [];
  const failures = [];
  const stamp = fileStamp();
  const uniqueScope = makeScopeFactory();

  if (options.fixtures.length) {
    log(t('offlineMode', options.fixtures.length));
    options.fixtures.forEach((file, index) => {
      const abs = path.resolve(cwd, file);
      let html;
      try {
        html = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        failures.push({ label: file, message: t('fixtureReadError', file, err.message) });
        return;
      }

      const parsed = parseUsageHtml(html);
      if (!parsed.ok) {
        failures.push({ label: path.basename(file), message: parseErrorMessage(t, parsed) });
        return;
      }

      const scope = accountScope(settings, index + 1, parsed.account, uniqueScope);
      const analysis = analyseParsed(parsed, settings, scope);
      analyses.push(analysis);
      log(
        t(
          'fixtureOk',
          path.basename(file),
          parsed.account || '?',
          analysis.stats.keptCount,
          analysis.stats.totalMb.toFixed(2),
          analysis.stats.ignoredCount,
          analysis.stats.highlightedCount
        )
      );
    });
  } else {
    const accounts = collectAccounts(env);
    if (accounts.length === 0) {
      log(t('noAccounts'));
      log(t('noAccountsCopy', path.relative(cwd, envPath) || '.env'));
      log(t('noAccountsExample'));
      log('');
      log(t('noAccountsFixtureHint'));
      process.exitCode = 1;
      return;
    }

    log(t('envLoaded', path.relative(cwd, envPath) || '.env', accounts.length));
    log(t('fetchSettings', settings.months, settings.type));
    log('');

    for (const account of accounts) {
      const masked = maskMsisdn(account.msisdn);
      const label = account.name ? `${account.name} (${masked})` : masked;
      log(t('loggingIn', label));
      try {
        const { html } = await fetchUsageForAccount({
          msisdn: account.msisdn,
          pin: account.pin,
          months: settings.months,
          type: settings.type,
          logger: log,
          lang,
        });

        if (options.saveRaw) {
          fs.mkdirSync(rawDir, { recursive: true });
          const rawFile = path.join(rawDir, `${safeSlug(account.msisdn) || masked}-${stamp}.html`);
          fs.writeFileSync(rawFile, html);
          log(t('rawSaved', path.relative(cwd, rawFile)));
        }

        const parsed = parseUsageHtml(html);
        if (!parsed.ok) {
          const message = parseErrorMessage(t, parsed);
          failures.push({ label, message });
          log(t('accountFailed', message));
          continue;
        }

        const scope = accountScope(settings, analyses.length + 1, parsed.account || account.msisdn, uniqueScope);
        const analysis = analyseParsed(parsed, settings, scope);
        analysis.msisdn = account.msisdn;
        analysis.owner = account.name || null;
        analysis.requestedType = settings.type;
        analysis.requestedMonths = settings.months;
        analyses.push(analysis);
        const who = account.name ? `${account.name} · ${parsed.account || masked}` : parsed.account || masked;
        log(
          t(
            'accountOk',
            who,
            analysis.stats.keptCount,
            analysis.stats.totalMb.toFixed(2),
            analysis.stats.ignoredCount,
            analysis.stats.highlightedCount
          )
        );
      } catch (err) {
        const message = err instanceof KoganError ? `${err.code}: ${err.message}` : err.message;
        failures.push({ label, message });
        log(t('accountFailed', message));
      }
      log('');
    }
  }

  if (analyses.length === 0) {
    log(t('noData'));
    for (const f of failures) log(t('failedItem', f.label, f.message));
    process.exitCode = 2;
    return;
  }

  const html = renderReport({
    analyses,
    generatedAt: formatNowSydney(),
    lang,
    redact: settings.redact,
    hideNames: settings.hideNames,
    settings,
    sourceLabel: 'accounts.koganmobile.com.au/service/usage',
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html, 'utf8');
  log(t('reportWritten', outFile));

  if (failures.length) {
    log('');
    log(t('failedItems'));
    for (const f of failures) log(t('failedItem', f.label, f.message));
    process.exitCode = 3;
  }

  if (options.open) openFile(outFile);
}

main().catch((err) => {
  const t = createTranslator(process.env.KOGAN_LANG);
  log(t('unexpectedError', err && err.stack ? err.stack : err));
  process.exitCode = 1;
});

module.exports = { parseArgs, formatNowSydney, normaliseType, normaliseMonths, CliError };
