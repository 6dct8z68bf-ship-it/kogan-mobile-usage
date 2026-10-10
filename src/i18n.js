'use strict';

/**
 * Minimal two-language message catalog (zh-Hant / en).
 *
 * The generated report carries both languages inside the HTML and switches
 * them with CSS. The CLI and console output use this catalog instead.
 */

const DEFAULT_LANG = 'zh';

/** Map any user supplied language tag onto a supported language code. */
function normalizeLang(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith('en')) return 'en';
  if (raw.startsWith('zh') || raw.startsWith('tw') || raw.startsWith('hk')) return 'zh';
  return null;
}

const USAGE = {
  zh: `Kogan Mobile 數據用量報告產生器

用法:
  node src/index.js [選項]

抓取（需要 .env 內的門號與 PIN）:
  node src/index.js                        # 讀 .env，登入抓取後產生報告
  node src/index.js --months 3 --type Data # 抓近 3 個月的數據用量
  node src/index.js --open                 # 產生後自動開啟報告

離線模式（直接用已存檔的 HTML，不需登入）:
  node src/index.js --fixture "Usage History.html"
  node src/index.js -f a.html -f b.html -o out/report.html

選項:
  -f, --fixture <file>     使用本機已存檔的 usage HTML（可重複指定）
      --env <file>         .env 路徑（預設 ./.env）
      --months <1|3|6>     抓取期間（預設 1）
      --type <type>        All | Data | SMSMMS | Calls（預設 Data）
      --min-mb <n>         小於此 MB 數忽略（預設 1）
      --highlight-mb <n>   大於此 MB 數 highlight（預設 50）
      --mb-base <n>        位元組(B)換算基準：1 MB = 多少 bytes（預設 1048576）
      --lang <zh|en>       輸出語言（預設 zh）
      --redact             以 Account 1..N 取代門號與姓名（要公開報告時使用）
  -o, --out <file>         輸出 HTML 路徑（預設 out/usage-report.html）
      --save-raw <dir>     保存抓取到的原始 HTML（預設 out/raw）
      --no-save-raw        不保存原始 HTML
      --open               產生後用系統預設瀏覽器開啟
  -h, --help               顯示本說明
`,

  en: `Kogan Mobile data usage report generator

Usage:
  node src/index.js [options]

Fetch (requires the phone numbers and PINs in .env):
  node src/index.js                        # read .env, sign in and fetch
  node src/index.js --months 3 --type Data # last 3 months of data usage
  node src/index.js --open                 # open the report when finished

Offline (use a saved HTML file, no sign-in):
  node src/index.js --fixture "Usage History.html"
  node src/index.js -f a.html -f b.html -o out/report.html

Options:
  -f, --fixture <file>     use a locally saved usage HTML file (repeatable)
      --env <file>         path to .env (default ./.env)
      --months <1|3|6>     period to fetch (default 1)
      --type <type>        All | Data | SMSMMS | Calls (default Data)
      --min-mb <n>         ignore records below this many MB (default 1)
      --highlight-mb <n>   highlight records above this many MB (default 50)
      --mb-base <n>        bytes per MB for byte-denominated rows (default 1048576)
      --lang <zh|en>       output language (default zh)
      --redact             replace phone numbers and names with Account 1..N
  -o, --out <file>         output HTML path (default out/usage-report.html)
      --save-raw <dir>     keep the fetched raw HTML (default out/raw)
      --no-save-raw        do not keep the fetched raw HTML
      --open               open the report with the default browser
  -h, --help               show this help
`,
};

const MESSAGES = {
  zh: {
    unknownOption: (opt) => `未知的選項：${opt}`,
    invalidNumber: (label, value) => `${label} 必須是正數，收到「${value}」。`,
    invalidMonths: (value) => `--months 只支援 1 / 3 / 6（網站僅提供 1、3、6 個月），收到「${value}」。`,

    offlineMode: (count) => `離線模式：讀取 ${count} 個本機 HTML 檔`,
    fixtureReadError: (file, message) => `讀不到檔案：${message}`,
    fixtureOk: (file, account, kept, mb, ignored, high) =>
      `  ${file} → ${account}：保留 ${kept} 筆 / ${mb} MB，忽略 ${ignored} 筆，high 亮 ${high} 筆`,

    noAccounts: '找不到任何帳號設定。',
    noAccountsCopy: (file) => `請把 .env.example 複製成 ${file} 並填入：`,
    noAccountsExample: '  KOGAN_ACCOUNTS=0400000000:123456',
    noAccountsFixtureHint: '（若只想先看報告長相，可用：node src/index.js --fixture "Usage History.html"）',

    envLoaded: (file, count) => `讀取 ${file}：共 ${count} 個門號`,
    fetchSettings: (months, type) => `抓取參數：近 ${months} 個月 / ${type}`,
    loggingIn: (label) => `登入 ${label} ...`,
    rawSaved: (file) => `  原始 HTML 已存：${file}`,
    accountOk: (account, kept, mb, ignored, high) =>
      `  ✓ ${account}：保留 ${kept} 筆 / ${mb} MB，忽略 ${ignored} 筆，high 亮 ${high} 筆`,
    accountFailed: (message) => `  ✗ ${message}`,
    noData: '沒有任何可產生報告的資料。',
    reportWritten: (file) => `報告已產生：${file}`,
    failedItems: '以下項目失敗（已跳過）：',
    unexpectedError: (err) => `未預期的錯誤：${err}`,
    failedItem: (label, message) => `  - ${label}：${message}`,

    loginSuccess: '  登入成功',
    usageFetched: '  已取得 usage 頁面',
    loginPageError: (status) => `無法載入登入頁（HTTP ${status}）。`,
    loginPageChanged: '登入頁找不到 csrfToken，網站版型可能已變更。',
    loginFailedWithMessage: (label, message) => `登入失敗（${label}）：${message}`,
    loginFailedDefault: (label) => `登入失敗（${label}）：請確認門號與 PIN 是否正確。`,
    sessionLost: 'session 已失效，無法開啟 usage 頁面。',
    sessionLostAfterQuery: '查詢 usage 後被導回登入頁，session 可能已過期。',
    usagePageChanged: 'usage 頁面找不到 csrfToken，網站版型可能已變更。',

    parseNotLoggedIn: '頁面仍是登入頁，session 可能已失效或登入失敗。',
    parseTableNotFound: (id) => `在 HTML 中找不到 <table id="${id}">。`,

    checkConnecting: '1) 連線 accounts.koganmobile.com.au ...',
    checkUsage: (months, type) => `2) 抓取 usage 頁面（近 ${months} 個月 / ${type}）...`,
    checkEnvAccount: (file) => `使用 ${file} 的第一組帳號`,
    checkNoAccount: '找不到帳號。請先建立 .env，或直接帶入門號與 PIN。',
    checkLoginFailed: '✗ 登入失敗',
    checkPinHint: '  → 請確認 .env 內的門號與 PIN（PIN 為 6 位數字）。',
    checkLoginOk: (label) => `✓ 登入成功（${label}）`,
    checkFetchFailed: (message) => `✗ 抓取失敗：${message}`,
    checkParseFailed: (message) => `✗ 解析失敗：${message}`,
    checkParseOk: '✓ 解析成功',
    checkRowAccount: (value) => `  門號      : ${value}`,
    checkRowForm: (value) => `  頁面期間  : ${value}`,
    checkRowFooter: (value) => `  頁尾合計  : ${value}`,
    checkRowRows: (value) => `  資料列數  : ${value}`,
    checkRowKept: (value) => `  保留      : ${value}`,
    checkRowIgnored: (value) => `  忽略 <1MB : ${value}`,
    checkRowHighlight: (value) => `  >50MB     : ${value}`,
    checkRowVoice: (value) => `  通話 / SMS: ${value}`,
    checkRawSaved: (file) => `原始 HTML 已存：${file}`,
    checkAllGood: '一切正常，可以執行 run.cmd 產生報告。',
  },

  en: {
    unknownOption: (opt) => `Unknown option: ${opt}`,
    invalidNumber: (label, value) => `${label} must be a positive number, got "${value}".`,
    invalidMonths: (value) =>
      `--months only supports 1 / 3 / 6 (the website offers 1, 3 and 6 months), got "${value}".`,

    offlineMode: (count) => `Offline mode: reading ${count} local HTML file(s)`,
    fixtureReadError: (file, message) => `cannot read file: ${message}`,
    fixtureOk: (file, account, kept, mb, ignored, high) =>
      `  ${file} -> ${account}: kept ${kept} / ${mb} MB, ignored ${ignored}, highlighted ${high}`,

    noAccounts: 'No account configured.',
    noAccountsCopy: (file) => `Copy .env.example to ${file} and fill in:`,
    noAccountsExample: '  KOGAN_ACCOUNTS=0400000000:123456',
    noAccountsFixtureHint: '(To preview the report first: node src/index.js --fixture "Usage History.html")',

    envLoaded: (file, count) => `Reading ${file}: ${count} account(s)`,
    fetchSettings: (months, type) => `Fetch settings: last ${months} month(s) / ${type}`,
    loggingIn: (label) => `Signing in as ${label} ...`,
    rawSaved: (file) => `  raw HTML saved: ${file}`,
    accountOk: (account, kept, mb, ignored, high) =>
      `  ok ${account}: kept ${kept} / ${mb} MB, ignored ${ignored}, highlighted ${high}`,
    accountFailed: (message) => `  failed: ${message}`,
    noData: 'Nothing to report.',
    reportWritten: (file) => `Report written: ${file}`,
    failedItems: 'The following items failed (skipped):',
    unexpectedError: (err) => `Unexpected error: ${err}`,
    failedItem: (label, message) => `  - ${label}: ${message}`,

    loginSuccess: '  signed in',
    usageFetched: '  usage page fetched',
    loginPageError: (status) => `Cannot load the sign-in page (HTTP ${status}).`,
    loginPageChanged: 'No csrfToken on the sign-in page; the site layout may have changed.',
    loginFailedWithMessage: (label, message) => `Sign-in failed (${label}): ${message}`,
    loginFailedDefault: (label) => `Sign-in failed (${label}): check the phone number and PIN.`,
    sessionLost: 'Session expired, cannot open the usage page.',
    sessionLostAfterQuery: 'The usage query redirected back to the sign-in page; the session may have expired.',
    usagePageChanged: 'No csrfToken on the usage page; the site layout may have changed.',

    parseNotLoggedIn: 'The page is still the sign-in page; the session may have expired or sign-in failed.',
    parseTableNotFound: (id) => `No <table id="${id}"> found in the HTML.`,

    checkConnecting: '1) Connecting to accounts.koganmobile.com.au ...',
    checkUsage: (months, type) => `2) Fetching the usage page (last ${months} month(s) / ${type})...`,
    checkEnvAccount: (file) => `Using the first account from ${file}`,
    checkNoAccount: 'No account found. Create .env first, or pass a phone number and PIN.',
    checkLoginFailed: 'Sign-in failed',
    checkPinHint: '  -> check the phone number and PIN in .env (the PIN is 6 digits).',
    checkLoginOk: (label) => `Signed in (${label})`,
    checkFetchFailed: (message) => `Fetch failed: ${message}`,
    checkParseFailed: (message) => `Parse failed: ${message}`,
    checkParseOk: 'Parsed successfully',
    checkRowAccount: (value) => `  account   : ${value}`,
    checkRowForm: (value) => `  page form : ${value}`,
    checkRowFooter: (value) => `  footer    : ${value}`,
    checkRowRows: (value) => `  rows      : ${value}`,
    checkRowKept: (value) => `  kept      : ${value}`,
    checkRowIgnored: (value) => `  ignored   : ${value}`,
    checkRowHighlight: (value) => `  >50MB     : ${value}`,
    checkRowVoice: (value) => `  calls/SMS : ${value}`,
    checkRawSaved: (file) => `Raw HTML saved: ${file}`,
    checkAllGood: 'All good - run the report generator to build the HTML.',
  },
};

/**
 * Build a translate function for one language.
 * Each key holds either a plain string or a function that formats its arguments.
 */
function createTranslator(lang) {
  const code = normalizeLang(lang) || DEFAULT_LANG;
  const table = MESSAGES[code];
  const translate = (key, ...args) => {
    const entry = table[key];
    if (typeof entry === 'function') return entry(...args);
    if (typeof entry === 'string') return entry;
    return key;
  };
  translate.lang = code;
  return translate;
}

function usageText(lang) {
  return USAGE[normalizeLang(lang) || DEFAULT_LANG];
}

module.exports = { DEFAULT_LANG, normalizeLang, createTranslator, usageText, MESSAGES, USAGE };
