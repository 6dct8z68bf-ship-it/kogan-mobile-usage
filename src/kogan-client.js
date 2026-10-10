'use strict';

const { HttpSession } = require('./http-session');
const { createTranslator } = require('./i18n');
const { maskPhoneNumber } = require('./mask');

const ORIGIN = 'https://accounts.koganmobile.com.au';
const LOGIN_URL = `${ORIGIN}/customer/login`;
const USAGE_URL = `${ORIGIN}/service/usage`;

class KoganError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'KoganError';
    this.code = code;
    this.details = details || null;
  }
}

function translator(input) {
  if (typeof input === 'function') return input;
  const lang = typeof input === 'string' ? input : input && input.lang;
  return createTranslator(lang);
}

/** Pull the CSRF token out of a rendered page. */
function extractCsrf(html) {
  const patterns = [
    /name=["']csrfToken["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']csrfToken["']/i,
    /["']csrfToken["']\s*:\s*["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

/** Collect the red inline error messages a failed sign-in renders. */
function extractLoginError(html) {
  const re = /<p\b[^>]*class=["'][^"']*\berror\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi;
  const messages = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) messages.push(text);
  }
  return messages.join(' / ');
}

function isLoginPage(html) {
  return /id=["']login-form["']/.test(html) || /Sign In to your Kogan Mobile/i.test(html);
}

/** 0400000001 -> 040****001, so logs never print a full phone number. */
function maskMsisdn(msisdn) {
  return maskPhoneNumber(msisdn);
}

/**
 * Sign in with a phone number and a PIN.
 *
 * Kogan Mobile has no OTP or 2FA: fetch the sign-in page for its csrfToken,
 * then POST the form. Cookies are kept by the session so later requests stay
 * authenticated.
 */
async function login(session, { msisdn, pin, lang, t: tInput }) {
  const t = translator(tInput || lang);

  const page = await session.request(LOGIN_URL);
  if (page.status !== 200) {
    throw new KoganError('LOGIN_PAGE_ERROR', t('loginPageError', page.status));
  }

  const csrf = extractCsrf(page.body);
  if (!csrf) {
    throw new KoganError('LOGIN_PAGE_CHANGED', t('loginPageChanged'));
  }

  const result = await session.postForm(
    LOGIN_URL,
    { csrfToken: csrf, user_name: msisdn, user_password: pin },
    { Referer: LOGIN_URL, Origin: ORIGIN }
  );

  // Being sent back to the sign-in page means wrong credentials or a block.
  if (isLoginPage(result.body) && new URL(result.url).pathname.startsWith('/customer/login')) {
    const message = extractLoginError(result.body);
    const label = maskMsisdn(msisdn);
    throw new KoganError(
      'LOGIN_FAILED',
      message ? t('loginFailedWithMessage', label, message) : t('loginFailedDefault', label),
      { url: result.url }
    );
  }

  return result;
}

/**
 * Fetch the usage page HTML.
 * months: 1 / 3 / 6; type: All / SMSMMS / Data / Calls
 */
async function fetchUsageHtml(session, { months = 1, type = 'Data', lang, t: tInput } = {}) {
  const t = translator(tInput || lang);

  const page = await session.request(USAGE_URL);
  if (isLoginPage(page.body)) {
    throw new KoganError('SESSION_LOST', t('sessionLost'));
  }

  const csrf = extractCsrf(page.body);
  if (!csrf) {
    throw new KoganError('USAGE_PAGE_CHANGED', t('usagePageChanged'));
  }

  const result = await session.postForm(
    USAGE_URL,
    {
      csrfToken: csrf,
      'usage-history-form[type]': type,
      'usage-history-form[months]': String(months),
    },
    { Referer: USAGE_URL, Origin: ORIGIN }
  );

  if (isLoginPage(result.body)) {
    throw new KoganError('SESSION_LOST', t('sessionLostAfterQuery'));
  }

  return result.body;
}

/** Convenience wrapper: new session -> sign in -> fetch the usage page. */
async function fetchUsageForAccount({ msisdn, pin, months, type, logger = () => {}, lang }) {
  const t = createTranslator(lang);
  const session = new HttpSession({ baseUrl: `${ORIGIN}/`, logger });
  await login(session, { msisdn, pin, t });
  logger(t('loginSuccess'));
  const html = await fetchUsageHtml(session, { months, type, t });
  logger(t('usageFetched'));
  return { html, session, msisdn };
}

module.exports = {
  KoganError,
  login,
  fetchUsageHtml,
  fetchUsageForAccount,
  extractCsrf,
  extractLoginError,
  isLoginPage,
  maskMsisdn,
  LOGIN_URL,
  USAGE_URL,
  ORIGIN,
};
