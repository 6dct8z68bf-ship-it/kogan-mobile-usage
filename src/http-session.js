'use strict';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Split a combined Set-Cookie header into individual cookies.
 *
 * Only needed when Headers.getSetCookie() is unavailable: fetching it as a
 * single header joins the values with ", ", but commas also appear inside
 * Expires dates, so a new cookie only starts where a name=value pair begins.
 */
function splitSetCookieHeader(value) {
  if (!value) return [];
  return String(value)
    .split(/,(?=\s*[^=;,\s]+=)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Small HTTP session that manages its own cookie jar and redirects.
 * Uses only the built-in fetch, with no external dependencies.
 */
class HttpSession {
  constructor({ baseUrl, timeoutMs = 45000, logger = () => {} } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.log = logger;
    this.cookies = new Map();
    this.history = [];
  }

  cookieHeader() {
    if (this.cookies.size === 0) return null;
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  storeCookies(response) {
    const list =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : splitSetCookieHeader(response.headers.get('set-cookie'));

    for (const raw of list) {
      if (!raw) continue;
      const [pair] = String(raw).split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      if (value === '' || /;\s*max-age=0(?!\d)/i.test(raw)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  /**
   * Send a request, following redirects and carrying cookies along.
   * Returns { status, url, headers, body }.
   */
  async request(rawUrl, options = {}) {
    const {
      method = 'GET',
      body,
      headers = {},
      maxRedirects = 8,
      follow = true,
    } = options;

    let url = new URL(rawUrl, this.baseUrl);
    let currentMethod = method.toUpperCase();
    let currentBody = body;
    let response = null;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const finalHeaders = {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        ...headers,
      };
      const cookie = this.cookieHeader();
      if (cookie) finalHeaders.Cookie = cookie;
      if (currentBody !== undefined && currentBody !== null && !finalHeaders['Content-Type']) {
        finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      this.log(`  → ${currentMethod} ${url.pathname}${url.search}`);
      response = await fetch(url, {
        method: currentMethod,
        body: currentBody,
        headers: finalHeaders,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      this.storeCookies(response);
      this.history.push({ url: url.toString(), status: response.status });

      const location = response.headers.get('location');
      const shouldFollow = follow && REDIRECT_CODES.has(response.status) && location;
      if (!shouldFollow) break;

      try {
        if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
      } catch {
        /* ignore */
      }

      url = new URL(location, url);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
    }

    const text = await response.text();
    return { status: response.status, url: url.toString(), headers: response.headers, body: text };
  }

  /** POST an application/x-www-form-urlencoded form. */
  postForm(url, fields, headers = {}) {
    const body = new URLSearchParams(fields).toString();
    return this.request(url, { method: 'POST', body, headers });
  }
}

module.exports = { HttpSession, DEFAULT_USER_AGENT };
