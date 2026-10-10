#!/usr/bin/env node
'use strict';

/**
 * Sign-in self check.
 *
 *   node scripts/check-login.js                 # first account from .env
 *   node scripts/check-login.js 0400000000 123456
 *   node scripts/check-login.js --save          # also keep the raw HTML
 *   node scripts/check-login.js --lang en
 *
 * It only signs in and fetches the usage page once; no report is generated.
 */

const fs = require('fs');
const path = require('path');

const { loadEnv, collectAccounts, resolveEnvPath } = require('../src/env');
const { HttpSession } = require('../src/http-session');
const { login, fetchUsageHtml, maskMsisdn, KoganError } = require('../src/kogan-client');
const { parseUsageHtml } = require('../src/parse-usage');
const { cleanUsage } = require('../src/clean-usage');
const { createTranslator, normalizeLang, DEFAULT_LANG } = require('../src/i18n');

const USAGE = {
  zh: `登入自我檢查

用法:
  node scripts/check-login.js [門號] [PIN] [--save] [--months 1] [--type Data] [--lang zh|en]

不給門號時會讀取 ./.env 的第一組帳號。
`,
  en: `Sign-in self check

Usage:
  node scripts/check-login.js [phone] [PIN] [--save] [--months 1] [--type Data] [--lang zh|en]

Without a phone number the first account from ./.env is used.
`,
};

function parseArgs(argv) {
  const out = { positional: [], save: false, months: 1, type: 'Data', lang: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (token === '--save') {
      out.save = true;
      continue;
    }
    if (token === '--months') {
      out.months = Number(argv[(i += 1)]) || 1;
      continue;
    }
    if (token === '--type') {
      out.type = argv[(i += 1)];
      continue;
    }
    if (token === '--lang') {
      out.lang = argv[(i += 1)];
      continue;
    }
    out.positional.push(token);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const envPath = resolveEnvPath(cwd, process.env.KOGAN_ENV);
  const env = loadEnv(envPath);
  const lang = normalizeLang(args.lang || env.KOGAN_LANG) || DEFAULT_LANG;
  const t = createTranslator(lang);

  if (args.help) {
    process.stdout.write(USAGE[lang]);
    return;
  }

  let [msisdn, pin] = args.positional;
  if (!msisdn || !pin) {
    const accounts = collectAccounts(env);
    if (accounts.length === 0) {
      process.stdout.write(`${t('checkNoAccount')}\n\n`);
      process.stdout.write(USAGE[lang]);
      process.exitCode = 1;
      return;
    }
    msisdn = msisdn || accounts[0].msisdn;
    pin = pin || accounts[0].pin;
    process.stdout.write(`${t('checkEnvAccount', path.relative(cwd, envPath) || '.env')}\n`);
  }

  const label = maskMsisdn(msisdn);
  process.stdout.write(`\n${t('checkConnecting')}\n`);

  const session = new HttpSession({
    baseUrl: 'https://accounts.koganmobile.com.au/',
    logger: (line) => process.stdout.write(`${line}\n`),
  });

  try {
    await login(session, { msisdn, pin, t });
  } catch (err) {
    process.stdout.write(`\n${t('checkLoginFailed')}\n`);
    process.stdout.write(`  ${err instanceof KoganError ? err.code : 'ERROR'}: ${err.message}\n`);
    if (err instanceof KoganError && err.code === 'LOGIN_FAILED') {
      process.stdout.write(`${t('checkPinHint')}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n${t('checkLoginOk', label)}\n`);
  process.stdout.write(`\n${t('checkUsage', args.months, args.type)}\n`);

  let html;
  try {
    html = await fetchUsageHtml(session, { months: args.months, type: args.type, t });
  } catch (err) {
    process.stdout.write(`\n${t('checkFetchFailed', err.message)}\n`);
    process.exitCode = 1;
    return;
  }

  const parsed = parseUsageHtml(html);
  if (!parsed.ok) {
    const message =
      parsed.error === 'TABLE_NOT_FOUND'
        ? t('parseTableNotFound', parsed.tableId || 'service-usage-history')
        : t('parseNotLoggedIn');
    process.stdout.write(`\n${t('checkParseFailed', message)}\n`);
    process.exitCode = 2;
    return;
  }

  const analysis = cleanUsage(parsed, {});
  process.stdout.write(`\n${t('checkParseOk')}\n`);
  process.stdout.write(`${t('checkRowAccount', parsed.account)}\n`);
  process.stdout.write(`${t('checkRowForm', JSON.stringify(parsed.form))}\n`);
  process.stdout.write(
    `${t('checkRowFooter', `Data ${parsed.footer.dataText || '-'} / SMS ${parsed.footer.smsCount || 0}`)}\n`
  );
  process.stdout.write(`${t('checkRowRows', parsed.rows.length)}\n`);
  process.stdout.write(
    `${t('checkRowKept', `${analysis.stats.keptCount} / ${analysis.stats.totalMb.toFixed(2)} MB`)}\n`
  );
  process.stdout.write(`${t('checkRowIgnored', `${analysis.stats.ignoredCount}`)}\n`);
  process.stdout.write(`${t('checkRowHighlight', `${analysis.stats.highlightedCount}`)}\n`);
  process.stdout.write(
    `${t('checkRowVoice', `${analysis.stats.voiceCount} / ${analysis.stats.smsCount}`)}\n`
  );

  if (args.save) {
    const rawDir = path.resolve(cwd, 'out/raw');
    fs.mkdirSync(rawDir, { recursive: true });
    const file = path.join(rawDir, 'check-login.html');
    fs.writeFileSync(file, html);
    process.stdout.write(`\n${t('checkRawSaved', path.relative(cwd, file))}\n`);
  }

  process.stdout.write(`\n${t('checkAllGood')}\n`);
}

main().catch((err) => {
  process.stdout.write(`${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
