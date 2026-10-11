#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { parseDurationOrSize, toMb } = require('../src/units');
const { parseUsageHtml } = require('../src/parse-usage');
const { cleanUsage, buildProjection } = require('../src/clean-usage');
const { renderReport, fmtMb } = require('../src/render-report');
const { parseEnvFile, collectAccounts } = require('../src/env');
const { maskPhoneNumber } = require('../src/mask');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'usage-history-sample.html');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

function approx(actual, expected, tolerance = 0.005) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `expected ${expected}, got ${actual}`
  );
}

process.stdout.write('\nunits: size and duration parsing\n');

test('parse bytes "965632 B"', () => {
  const r = parseDurationOrSize('965632 B');
  assert.strictEqual(r.kind, 'size');
  assert.strictEqual(r.bytes, 965632);
  approx(r.mb, 965632 / 1048576);
});

test('parse MB "8.32 MB"', () => {
  const r = parseDurationOrSize('8.32 MB');
  assert.strictEqual(r.mb, 8.32);
});

test('byte base is configurable (mbBase)', () => {
  assert.strictEqual(parseDurationOrSize('1048576 B', { mbBase: 1048576 }).mb, 1);
  assert.strictEqual(parseDurationOrSize('1000000 B', { mbBase: 1e6 }).mb, 1);
});

test('parse GB / KB', () => {
  assert.strictEqual(parseDurationOrSize('1.5 GB').mb, 1536);
  assert.strictEqual(parseDurationOrSize('2048 KB').mb, 2);
  assert.strictEqual(parseDurationOrSize('1 GiB').mb, 1024);
});

test('parse call durations 00:03 / 1:50', () => {
  assert.strictEqual(parseDurationOrSize('00:03').seconds, 3);
  assert.strictEqual(parseDurationOrSize('1:50').seconds, 110);
  assert.strictEqual(parseDurationOrSize('01:00:00').seconds, 3600);
});

test('empty and unknown values return null', () => {
  assert.strictEqual(parseDurationOrSize(''), null);
  assert.strictEqual(parseDurationOrSize(null), null);
  assert.strictEqual(parseDurationOrSize('abc'), null);
});

test('toMb conversion', () => {
  approx(toMb(1048576, 1048576), 1);
  approx(toMb(524288, 1048576), 0.5);
});

test('maskPhoneNumber keeps the first and last three digits', () => {
  assert.strictEqual(maskPhoneNumber('0400000123'), '040****123');
  assert.strictEqual(maskPhoneNumber('0400 000 123'), '040****123');
  assert.strictEqual(maskPhoneNumber('61400000012'), '614*****012');
  assert.strictEqual(maskPhoneNumber('Account 1'), 'Account 1');
  assert.strictEqual(maskPhoneNumber(''), '');
  assert.strictEqual(maskPhoneNumber(undefined), '');
});

process.stdout.write('\nenv: .env parsing\n');

test('parse multiple accounts from KOGAN_ACCOUNTS', () => {
  const env = parseEnvFile('KOGAN_ACCOUNTS=0400000000:123456, 0455555555:654321\n# comment\n');
  const accounts = collectAccounts(env);
  assert.strictEqual(accounts.length, 2);
  assert.deepStrictEqual(accounts[0], {
    msisdn: '0400000000',
    pin: '123456',
    name: null,
    source: 'KOGAN_ACCOUNTS',
  });
  assert.deepStrictEqual(accounts[1], {
    msisdn: '0455555555',
    pin: '654321',
    name: null,
    source: 'KOGAN_ACCOUNTS',
  });
});

test('parse numbered accounts and drop duplicates', () => {
  const env = parseEnvFile(
    ['KOGAN_MSISDN_1=0400000000', 'KOGAN_PIN_1=111111', 'KOGAN_MSISDN_2=0411111111', 'KOGAN_PIN_2=222222'].join('\n')
  );
  const accounts = collectAccounts(env);
  assert.strictEqual(accounts.length, 2);
  assert.strictEqual(accounts[1].msisdn, '0411111111');

  const dup = collectAccounts(parseEnvFile('KOGAN_ACCOUNTS=0400000000:111111\nKOGAN_MSISDN_1=0400000000\nKOGAN_PIN_1=111111'));
  assert.strictEqual(dup.length, 1);
});

test('attaches owner names from KOGAN_OWNERS', () => {
  const env = parseEnvFile(
    ['KOGAN_ACCOUNTS=0400000000:111111,0455555555:222222', 'KOGAN_OWNERS=0400000000:Alice, 0455555555:Bob'].join('\n')
  );
  const accounts = collectAccounts(env);
  assert.strictEqual(accounts[0].name, 'Alice');
  assert.strictEqual(accounts[1].name, 'Bob');
});

test('supports inline and numbered owner names', () => {
  const inline = collectAccounts(parseEnvFile('KOGAN_ACCOUNTS=0400000009:111111:Carol'));
  assert.strictEqual(inline[0].name, 'Carol');

  const numbered = collectAccounts(
    parseEnvFile(['KOGAN_MSISDN_1=0400000009', 'KOGAN_PIN_1=222222', 'KOGAN_NAME_1=Dave'].join('\n'))
  );
  assert.strictEqual(numbered[0].name, 'Dave');
});

test('accounts without a name stay null and numbers are normalised', () => {
  const accounts = collectAccounts(parseEnvFile('KOGAN_ACCOUNTS=0400 000 099:111111'));
  assert.strictEqual(accounts[0].msisdn, '0400000099');
  assert.strictEqual(accounts[0].name, null);
});

if (!fs.existsSync(FIXTURE)) {
  process.stdout.write(`\n(skipping fixture tests: ${path.relative(ROOT, FIXTURE)} not found)\n`);
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed ? 1 : 0;
  return;
}

const html = fs.readFileSync(FIXTURE, 'utf8');
const parsed = parseUsageHtml(html);

process.stdout.write('\nparse: parsing the sample page\n');

test('parses and reports the account label', () => {
  assert.strictEqual(parsed.ok, true, parsed.message);
  assert.strictEqual(parsed.account, '0400 000 001');
});

test('reads 56 rows and the header', () => {
  assert.strictEqual(parsed.rows.length, 56);
  assert.deepStrictEqual(parsed.columns.slice(0, 7), [
    'Date',
    'Time',
    'Type',
    'Country',
    'Number',
    'Duration/MB',
    'Charged',
  ]);
});

test('reads the footer total Data: 1105.16 MB', () => {
  assert.strictEqual(parsed.footer.dataText, '1105.16 MB');
  assert.strictEqual(parsed.footer.smsCount, 9);
});

process.stdout.write('\nclean: cleanup rules\n');

const analysis = cleanUsage(parsed, { minMb: 1, highlightMb: 50 });

test('ignores 8 records below 1 MB', () => {
  assert.strictEqual(analysis.stats.ignoredCount, 8);
  assert.ok(analysis.ignored.every((r) => r.bytes < 1e6));
  assert.ok(analysis.kept.every((r) => r.bytes >= 1e6));
});

test('highlights 5 records above 50 MB', () => {
  assert.strictEqual(analysis.stats.highlightedCount, 5);
  assert.ok(analysis.highlighted.every((r) => r.bytes > 50e6));
  assert.ok(analysis.kept.filter((r) => !r.highlighted).every((r) => r.bytes <= 50e6));
});

test('keeps 23 records totalling 1103.23 MB', () => {
  assert.strictEqual(analysis.stats.keptCount, 23);
  approx(analysis.stats.totalMb, 1103.23);
  assert.strictEqual(analysis.stats.maxMb, 254.16);
});

test('raw total matches the footer (1024-based byte rows)', () => {
  const diff = Math.abs(analysis.stats.rawTotalMb - 1105.16);
  assert.ok(diff <= 0.02, `difference ${diff.toFixed(4)} MB`);
});

test('daily summary covers 4 days and adds up to the total', () => {
  assert.strictEqual(analysis.days.length, 4);
  const sum = analysis.days.reduce((acc, d) => acc + d.mb, 0);
  approx(sum, analysis.stats.totalMb, 0.01);
});

test('classifies 16 call and 9 SMS records outside the data totals', () => {
  assert.strictEqual(analysis.stats.voiceCount, 16);
  assert.strictEqual(analysis.stats.smsCount, 9);
  assert.strictEqual(analysis.stats.invalidCount, 0);
  assert.strictEqual(analysis.stats.otherCount, 0);
});

test('footer difference stays inside the rounding tolerance', () => {
  const diff = Math.abs(analysis.stats.rawTotalMb - 1105.16);
  assert.ok(diff <= Math.max(0.05, analysis.stats.roundingErrorMb), `difference ${diff}`);
});

test('detail rows are sorted newest first', () => {
  const first = analysis.kept[0];
  const last = analysis.kept[analysis.kept.length - 1];
  assert.strictEqual(first.dateDisplay, '09/10/2026');
  // The 09/10 16:00 row is 965632 B (< 1 MB) and gets ignored, so the newest
  // kept row is 15:00.
  assert.strictEqual(first.timeDisplay, '15:00:00');
  assert.strictEqual(last.dateDisplay, '06/10/2026');
  assert.strictEqual(last.timeDisplay, '09:05:32');
  const keys = analysis.kept.map((r) => r.sortKey);
  const sorted = [...keys].sort().reverse();
  assert.deepStrictEqual(keys, sorted, 'sort keys should be descending');
});

test('boundary values: 1 MB kept, 50 MB not flagged', () => {
  const synthetic = {
    account: 'TEST',
    rows: [
      { date: '01/01/2026', time: '01:00:00', type: 'Domestic Data', country: 'Australia', number: 'Internet', durationMB: '1 MB', charged: 'From Pack' },
      { date: '01/01/2026', time: '02:00:00', type: 'Domestic Data', country: 'Australia', number: 'Internet', durationMB: '50 MB', charged: 'From Pack' },
      { date: '01/01/2026', time: '03:00:00', type: 'Domestic Data', country: 'Australia', number: 'Internet', durationMB: '0.99 MB', charged: 'From Pack' },
    ],
  };
  const result = cleanUsage(synthetic, { minMb: 1, highlightMb: 50 });
  assert.strictEqual(result.stats.keptCount, 2);
  assert.strictEqual(result.stats.ignoredCount, 1);
  assert.strictEqual(result.stats.highlightedCount, 0);
});

test('projects the average rate forward to the plan expiry', () => {
  const synthetic = {
    account: 'TEST',
    rows: [
      { date: '01/01/2026', time: '01:00:00', type: 'Domestic Data', country: 'Australia', number: 'Internet', durationMB: '100 MB', charged: 'From Pack' },
      { date: '02/01/2026', time: '01:00:00', type: 'Domestic Data', country: 'Australia', number: 'Internet', durationMB: '300 MB', charged: 'From Pack' },
    ],
  };
  const result = cleanUsage(synthetic, { minMb: 1, highlightMb: 50, projectUntil: '2026-01-11' });
  const p = result.projection;
  assert.ok(p, 'projection expected');
  assert.strictEqual(p.spanDays, 2);
  approx(p.totalMb, 400, 0.001);
  approx(p.avgPerDayMb, 200, 0.001);
  assert.strictEqual(p.remainingDays, 9);
  approx(p.projectedTotalMb, 2200, 0.001);
  assert.strictEqual(p.points.length, 2);
  assert.strictEqual(p.points[0].cumulativeMb.toFixed(0), '100');
  assert.strictEqual(p.points[1].cumulativeMb.toFixed(0), '400');
});

test('projection fills gaps with zero usage days', () => {
  const p = buildProjection(
    [
      { dateIso: '2026-01-01', mb: 100 },
      { dateIso: '2026-01-04', mb: 100 },
    ],
    { projectUntil: '2026-01-04' }
  );
  assert.strictEqual(p.spanDays, 4);
  assert.strictEqual(p.points.length, 4);
  assert.deepStrictEqual(p.points.map((x) => x.cumulativeMb), [100, 100, 100, 200]);
  assert.strictEqual(p.remainingDays, 0);
  approx(p.projectedTotalMb, 200, 0.001);
});

process.stdout.write('\nrender: HTML output\n');

test('renders a standalone HTML report with the key elements', () => {
  const out = renderReport({
    analyses: [analysis],
    generatedAt: '2026-10-10 12:00 (Australia/Sydney)',
    settings: { mbBase: 1048576, minMb: 1, highlightMb: 50 },
    sourceLabel: 'accounts.koganmobile.com.au/service/usage',
  });
  assert.ok(out.startsWith('<!DOCTYPE html>'), 'should start with a DOCTYPE');
  assert.ok(out.includes('<style>'), 'CSS must be inlined');
  assert.ok(!/https?:\/\/[^"']*\.(css|js)/.test(out), 'must not reference external CSS/JS');
  assert.ok(out.includes('0400 000 001'));
  assert.ok(out.includes('高用量') && out.includes('High usage'), 'both languages must be embedded');
  assert.ok(out.includes('254.16 MB'));
  assert.ok(!out.includes('undefined'));
  assert.ok(!out.includes('NaN'));
});

test('adds an overview table for multiple accounts', () => {
  const secondHtml = html.replace('0400 000 001', '0400 000 099');
  const second = cleanUsage(parseUsageHtml(secondHtml), { minMb: 1, highlightMb: 50 });
  second.scope = 'acct-second';
  const first = { ...analysis, scope: 'acct-first' };
  const out = renderReport({
    analyses: [first, second],
    generatedAt: '2026-10-10 12:00 (Australia/Sydney)',
    settings: { mbBase: 1048576, minMb: 1, highlightMb: 50 },
  });
  assert.ok(out.includes('所有門號總覽'), 'overview section expected');
  assert.ok(out.includes('All accounts overview'), 'overview section expected in English too');
  assert.ok(out.includes('0400 000 099'), 'second account expected');
  assert.ok(out.includes('2 個門號'));
  const dupIds = out.match(/id="acct-first"/g) || [];
  assert.strictEqual(dupIds.length, 1, 'ids must be unique');
});

test('embeds both languages and honours the default language', () => {
  const outZh = renderReport({
    analyses: [analysis],
    generatedAt: '2026-10-10 12:00 (Australia/Sydney)',
    settings: { mbBase: 1048576, minMb: 1, highlightMb: 50 },
    lang: 'zh',
  });
  assert.ok(outZh.includes('data-lang="zh"'), 'zh should be the default');
  assert.ok(outZh.includes('data-lang-btn="en"'), 'language switch expected');
  assert.ok(/data-report-id="202610101200"/.test(outZh), 'report id derived from the timestamp');
  assert.ok(
    outZh.includes("'kogan-usage-report-lang:' + (html.getAttribute('data-report-id')"),
    'language choice is remembered per report'
  );
  assert.ok(outZh.includes('<span class="i18n-zh">數據用量報告</span>'), 'zh heading expected');
  assert.ok(outZh.includes('<span class="i18n-en">Data usage report</span>'), 'en heading expected');

  const outEn = renderReport({
    analyses: [analysis],
    generatedAt: '2026-10-10 12:00 (Australia/Sydney)',
    settings: { mbBase: 1048576, minMb: 1, highlightMb: 50 },
    lang: 'en',
  });
  assert.ok(outEn.includes('data-lang="en"'), 'en should be selectable');
  assert.ok(outEn.includes('<title>Kogan Mobile data usage report'), 'english title expected');
});

test('shows owner names when they are configured', () => {
  const alice = { ...analysis, scope: 'acct-alice', owner: 'Alice' };
  const bob = { ...analysis, scope: 'acct-bob', account: '0411 222 333', owner: 'Bob' };
  const out = renderReport({
    analyses: [alice, bob],
    generatedAt: '2026-10-10 12:00 (Australia/Sydney)',
    settings: { mbBase: 1048576, minMb: 1, highlightMb: 50 },
  });
  assert.ok(out.includes('<span class="acct-num">0400 000 001</span>'), 'number as suffix');
  assert.ok(out.includes('>Alice<'), 'owner in the section heading');
  assert.ok(out.includes('<span class="i18n-zh">姓名</span>'), 'zh owner column');
  assert.ok(out.includes('<span class="i18n-en">Owner</span>'), 'en owner column');

  const withoutOwners = renderReport({
    analyses: [{ ...analysis, scope: 'acct-x' }],
    generatedAt: '2026-10-10 12:00 (Australia/Sydney)',
    settings: { mbBase: 1048576, minMb: 1, highlightMb: 50 },
  });
  assert.ok(!withoutOwners.includes('姓名'), 'no owner column when no names are set');
});

test('redact mode hides phone numbers but keeps the owner names', () => {
  const first = { ...analysis, scope: 'account-1', owner: 'dad' };
  const second = { ...analysis, scope: 'account-2', account: '0499 999 999', owner: 'mum' };
  const out = renderReport({
    analyses: [first, second],
    generatedAt: '2026-10-10 12:00 (Australia/Sydney)',
    settings: { mbBase: 1048576, minMb: 1, highlightMb: 50 },
    redact: true,
  });
  assert.ok(!out.includes('0400 000 001'), 'phone number must be hidden');
  assert.ok(!out.includes('0499 999 999'), 'second phone number must be hidden');
  assert.ok(out.includes('>dad<'), 'owner name kept as a label');
  assert.ok(out.includes('>mum<'), 'second owner name kept');
  assert.ok(out.includes('Account 1') && out.includes('Account 2'), 'position based labels');
});

test('hide-names drops the owner names as well', () => {
  const first = { ...analysis, scope: 'account-1', owner: 'dad' };
  const out = renderReport({
    analyses: [first],
    generatedAt: '2026-10-10 12:00 (Australia/Sydney)',
    settings: { mbBase: 1048576, minMb: 1, highlightMb: 50 },
    redact: true,
    hideNames: true,
  });
  assert.ok(!out.includes('dad'), 'owner name must be hidden');
  assert.ok(out.includes('Account 1'), 'position label still used');
  assert.ok(!out.includes('姓名') && !out.includes('>Owner<'), 'no owner column');
});

test('mask-numbers shows a partially masked phone number', () => {
  const first = { ...analysis, scope: 'account-1', account: '0400 000 123', owner: 'dad' };
  const out = renderReport({
    analyses: [first],
    generatedAt: '2026-10-10 12:00 (Australia/Sydney)',
    settings: { mbBase: 1048576, minMb: 1, highlightMb: 50 },
    maskNumbers: true,
  });
  assert.ok(out.includes('040****123'), 'masked number used as the label');
  assert.ok(!out.includes('0400 000 123'), 'the full number must not appear');
  assert.ok(!out.includes('0400000123'), 'the unspaced number must not appear');
  assert.ok(out.includes('>dad<'), 'owner name is kept');
});

test('renders the cumulative usage chart with the projection', () => {
  const withProjection = cleanUsage(parseUsageHtml(html), { minMb: 1, highlightMb: 50, projectUntil: '2027-10-06' });
  const out = renderReport({
    analyses: [withProjection],
    generatedAt: '2026-10-11 10:00 (Australia/Sydney)',
    settings: { mbBase: 1048576, minMb: 1, highlightMb: 50 },
  });
  assert.ok(out.includes('<svg'), 'inline svg expected');
  assert.ok(out.includes('class="proj-line"'), 'dashed projection line expected');
  assert.ok(out.includes('Cumulative usage and projection'), 'section title expected');
  assert.ok(out.includes('累積用量與投射'), 'zh section title expected');
  assert.ok(out.includes('06/10/2027'), 'projection date in the caption');
  assert.ok(/proj-label[^>]*>[^<]*GB</.test(out), 'projected total label expected');
});

test('adds the projected total to the overview table', () => {
  const first = cleanUsage(parseUsageHtml(html), { minMb: 1, highlightMb: 50, projectUntil: '2027-10-06' });
  const second = { ...first, scope: 'account-2', account: '0499 999 999' };
  const out = renderReport({
    analyses: [first, second],
    generatedAt: '2026-10-11 10:00 (Australia/Sydney)',
    settings: { mbBase: 1048576, minMb: 1, highlightMb: 50 },
  });
  const table = out.match(/<table class="overview-table">[\s\S]*?<\/table>/)[0];
  assert.ok(table.includes('Projected by 06/10/2027'), 'projected column header');
  assert.ok(table.includes('投射至 06/10/2027'), 'zh projected column header');
  assert.ok(table.includes(fmtMb(first.projection.projectedTotalMb)), 'projected total in the table');
  assert.ok(out.includes('carried straight to 06/10/2027'), 'projection explained under the table');
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;
