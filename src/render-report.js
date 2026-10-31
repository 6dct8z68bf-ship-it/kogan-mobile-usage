'use strict';

const fs = require('fs');
const path = require('path');

const { DEFAULT_LANG, normalizeLang } = require('./i18n');
const { maskPhoneNumber } = require('./mask');
const { isoToUtc, utcToIso, isoToShortDisplay } = require('./clean-usage');

const STYLES = fs.readFileSync(path.join(__dirname, 'report.css'), 'utf8');

function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

/**
 * Emit both languages inside one element. The stylesheet shows only the
 * variant matching the `data-lang` attribute on <html>, so switching language
 * needs no re-render and keeps working when JavaScript is unavailable.
 */
function bi(zh, en) {
  return `<span class="i18n-zh">${esc(zh)}</span><span class="i18n-en">${esc(en)}</span>`;
}

function fmtMb(mb, digits = 2) {
  const value = Number(mb) || 0;
  if (value >= 1000) return `${(value / 1000).toFixed(digits)} GB`;
  return `${value.toFixed(digits)} MB`;
}

function fmtNum(value, digits = 2) {
  return (Number(value) || 0).toLocaleString('en-AU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtInt(value) {
  return (Number(value) || 0).toLocaleString('en-AU');
}

function pct(value, digits = 1) {
  return `${fmtNum(value, digits)}%`;
}

function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Period label taken from the requested query first, then the page form. */
function periodLabel(analysis) {
  const requested = analysis.requestedMonths;
  const formValue = analysis.form && analysis.form.months ? String(analysis.form.months.value || '') : '';
  const months = requested !== undefined && requested !== null ? String(requested) : formValue;

  if (/^\d+$/.test(months)) {
    const n = Number(months);
    return { zh: `近 ${n} 個月`, en: `Last ${n} month${n === 1 ? '' : 's'}` };
  }

  const label = analysis.form && analysis.form.months ? analysis.form.months.label : '';
  return { zh: label || '未指定期間', en: label || 'Unspecified period' };
}

/**
 * Usage type. The requested query wins because the page <select> is never
 * re-rendered by the server, so it always shows the first option.
 */
function typeLabel(analysis) {
  if (analysis.requestedType) return analysis.requestedType;
  const form = analysis.form && analysis.form.type;
  if (form) return String(form.label || form.value || '').trim();
  return analysis.type || 'All';
}

/**
 * Label for one account.
 *
 * Two ways to keep a published report from carrying a full phone number:
 *   --mask-numbers  0400 000 123 -> 040****123 (still recognisable to you)
 *   --redact        -> Account 1, numbered by the order of KOGAN_ACCOUNTS
 * --mask-numbers wins when both are set.
 */
function accountLabel(analysis, index, options) {
  if (options.maskNumbers) return maskPhoneNumber(analysis.account);
  if (options.redact) return `Account ${index + 1}`;
  return analysis.account || `Account ${index + 1}`;
}

/**
 * Owner name.
 *
 * --redact keeps it, because a nickname is what makes a redacted report
 * readable; only the phone number is sensitive. Use --hide-names when the names
 * themselves must not appear either.
 */
function ownerLabel(analysis, hideNames) {
  if (hideNames) return '';
  return String(analysis.owner || '').trim();
}

const SCRIPT = `
(function () {
  var html = document.documentElement;
  // The stylesheet expands every day's records while this class is present, so a
  // reader without JavaScript still gets the full detail.
  html.classList.remove('no-js');
  var LEGACY_LANG_KEY = 'kogan-usage-report-lang';
  var bars = Array.prototype.slice.call(document.querySelectorAll('[data-filter-bar]'));
  var counts = [];

  // The choice is remembered per generated report, so a stale preference from an
  // older report can never override the language this file was generated with.
  function storageKey() {
    return 'kogan-usage-report-lang:' + (html.getAttribute('data-report-id') || 'default');
  }

  function currentLang() {
    return html.getAttribute('data-lang') === 'en' ? 'en' : 'zh';
  }

  function countTemplate() {
    var attr = currentLang() === 'en' ? 'data-count-en' : 'data-count-zh';
    return html.getAttribute(attr) || '';
  }

  function refreshCounts() {
    counts.forEach(function (item) {
      var shown = item.rows.filter(function (tr) { return !tr.hidden; }).length;
      item.el.textContent = countTemplate()
        .replace('{shown}', String(shown))
        .replace('{total}', String(item.rows.length));
    });
  }

  function applyLang(lang, persist) {
    html.setAttribute('data-lang', lang);
    html.setAttribute('lang', lang === 'en' ? 'en' : 'zh-Hant');
    var title = html.getAttribute(lang === 'en' ? 'data-title-en' : 'data-title-zh');
    if (title) document.title = title;
    document.querySelectorAll('[data-lang-btn]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-lang-btn') === lang);
    });
    if (persist) {
      try { localStorage.setItem(storageKey(), lang); } catch (err) { /* file:// may block storage */ }
    }
    refreshCounts();
  }

  document.querySelectorAll('[data-lang-btn]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      applyLang(btn.getAttribute('data-lang-btn'), true);
    });
  });

  /*
   * Each day in the daily chart carries its own records. Clicking a day opens
   * them, clicking it again closes them, and Enter or Space does the same from
   * the keyboard. Opening one day closes the others, so the page never grows a
   * wall of tables.
   */
  var days = Array.prototype.slice.call(document.querySelectorAll('.chart .day'));

  function setOpen(day, open) {
    if (!day) return;
    day.classList.toggle('is-open', open);
    var row = day.querySelector('.chart-row');
    if (row) row.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  days.forEach(function (day) {
    var row = day.querySelector('.chart-row');
    if (!row) return;
    row.addEventListener('click', function () {
      var open = !day.classList.contains('is-open');
      days.forEach(function (other) {
        if (other !== day) setOpen(other, false);
      });
      setOpen(day, open);
    });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        row.click();
      } else if (event.key === 'Escape') {
        setOpen(day, false);
      }
    });
  });

  /*
   * Months start closed: a six month report is a handful of header lines, each
   * already showing its month's total, instead of several screens of bars. The
   * header is a button, so Enter and Space work as they do on the day rows.
   */
  document.querySelectorAll('.chart .month').forEach(function (month) {
    var head = month.querySelector('.month-head');
    if (!head) return;
    head.addEventListener('click', function () {
      var open = !month.classList.contains('is-open');
      month.classList.toggle('is-open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  bars.forEach(function (bar) {
    var day = bar.closest('.day');
    var rows = day ? Array.prototype.slice.call(day.querySelectorAll('tr[data-kind="row"]')) : [];
    var countEl = bar.querySelector('.count');
    if (countEl) counts.push({ el: countEl, rows: rows });

    bar.addEventListener('click', function (event) {
      var btn = event.target.closest('button[data-filter]');
      if (!btn) return;
      bar.querySelectorAll('button[data-filter]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      var mode = btn.getAttribute('data-filter');
      rows.forEach(function (tr) {
        tr.hidden = mode === 'high' && tr.getAttribute('data-high') !== '1';
      });
      refreshCounts();
    });
  });

  // Drop the key older reports used, which was shared across every report and
  // could force a language different from the one this file was generated with.
  try { localStorage.removeItem(LEGACY_LANG_KEY); } catch (err) { /* ignore */ }

  var saved = null;
  try { saved = localStorage.getItem(storageKey()); } catch (err) { /* ignore */ }
  if (saved === 'en' || saved === 'zh') {
    applyLang(saved, false);
  } else {
    applyLang(currentLang(), false);
  }
})();
`;

function renderSummaryCards(analysis) {
  const s = analysis.stats;
  const cfg = analysis.config;
  return `
      <div class="cards">
        <div class="card">
          <div class="label">${bi('清理後總用量', 'Total usage after cleanup')}</div>
          <div class="value">${esc(fmtMb(s.totalMb))}</div>
          <div class="sub">${bi(
            `${fmtInt(s.keptCount)} 筆記錄・${fmtInt(s.days)} 天`,
            `${fmtInt(s.keptCount)} records · ${fmtInt(s.days)} days`
          )}</div>
        </div>
        <div class="card card--high">
          <div class="label">${bi(`高用量 > ${cfg.highlightMb} MB`, `High usage > ${cfg.highlightMb} MB`)}</div>
          <div class="value">${bi(`${fmtInt(s.highlightedCount)} 筆`, `${fmtInt(s.highlightedCount)}`)}</div>
          <div class="sub">${bi(
            `合計 ${fmtMb(s.highlightedMb)}・佔 ${pct(s.highlightedSharePct)}`,
            `Total ${fmtMb(s.highlightedMb)} · ${pct(s.highlightedSharePct)}`
          )}</div>
        </div>
        <div class="card${s.ignoredCount ? '' : ' card--ok'}">
          <div class="label">${bi(`已忽略 < ${cfg.minMb} MB`, `Ignored < ${cfg.minMb} MB`)}</div>
          <div class="value">${bi(`${fmtInt(s.ignoredCount)} 筆`, `${fmtInt(s.ignoredCount)}`)}</div>
          <div class="sub">${bi(
            `合計 ${fmtMb(s.ignoredMb)}（原始資料的 ${pct(s.ignoredSharePct)}）`,
            `Total ${fmtMb(s.ignoredMb)} (${pct(s.ignoredSharePct)} of raw data)`
          )}</div>
        </div>
        <div class="card">
          <div class="label">${bi('單筆最大 / 平均', 'Largest / average record')}</div>
          <div class="value">${esc(fmtMb(s.maxMb))}</div>
          <div class="sub">${bi(`平均每筆 ${fmtMb(s.avgMb)}`, `Average ${fmtMb(s.avgMb)}`)}</div>
        </div>
      </div>`;
}

/** One record's row inside a day's detail table. */
function renderDetailRow(r, max) {
  const width = Math.max(0.8, (r.mb / max) * 100);
  const isHigh = r.highlighted;
  return `              <tr data-kind="row" data-date="${esc(r.dateIso)}" data-high="${isHigh ? '1' : '0'}"${
    isHigh ? ' class="row-high"' : ''
  }>
                <td class="mono">${esc(r.dateDisplay)}</td>
                <td class="mono">${esc(r.timeDisplay)}</td>
                <td>${esc(r.type)}</td>
                <td>${esc(r.country)}</td>
                <td class="num strong">${esc(fmtMb(r.mb))}</td>
                <td class="bar-cell"><span class="mini-track"><span class="mini-bar${
                  isHigh ? ' is-high' : ''
                }" style="width:${width.toFixed(2)}%"></span></span></td>
                <td class="num">${esc(pct(r.sharePct))}</td>
                <td>${
                  isHigh
                    ? `<span class="badge">${bi('高用量', 'High')}</span>`
                    : `<span class="badge badge--muted">${bi('一般', 'Normal')}</span>`
                }</td>
              </tr>`;
}

/**
 * One day of the daily chart, with that day's records folded underneath.
 *
 * The bar row is the handle: clicking it unfolds the records, and clicking it
 * again folds them away. Enter and Space do the same from the keyboard. Each day
 * keeps its own "all / high only" toolbar, so filtering one day never changes
 * what another day shows.
 */
function renderDay(analysis, day, rows, max) {
  // Reports generated by the CLI always carry a scope; fall back for direct use.
  const id = `${analysis.scope || 'account'}-${day.dateIso}`;
  const width = Math.max(1.5, (day.mb / max) * 100);
  const barClass = day.heavy ? 'chart-bar is-high' : 'chart-bar';
  const rowMax = analysis.stats.maxMb || 1;
  const body = rows.map((r) => renderDetailRow(r, rowMax)).join('\n');

  return `        <div class="day" data-date="${esc(day.dateIso)}">
          <div class="chart-row" tabindex="0" role="button" aria-controls="${esc(
            id
          )}" aria-expanded="false" aria-label="${esc(`${day.dateDisplay} ${fmtMb(day.mb)}`)}">
            <span class="chart-date">${esc(day.dateDisplay.slice(0, 5))}</span>
            <span class="chart-track"><span class="${barClass}" style="width:${width.toFixed(2)}%"></span></span>
            <span class="chart-val">${esc(fmtMb(day.mb))}${day.heavy ? ' <em>&#9873;</em>' : ''}</span>
          </div>
          <div class="day-detail" id="${esc(id)}">
            <div class="toolbar" data-filter-bar="${esc(id)}">
              <button type="button" data-filter="all" class="active">${bi('全部', 'All')}</button>
              <button type="button" data-filter="high">${bi(
                `只看 > ${analysis.config.highlightMb} MB`,
                `Only > ${analysis.config.highlightMb} MB`
              )}</button>
              <span class="spacer"></span>
              <span class="count"></span>
            </div>
            <div class="table-shell">
              <table class="detail-table">
                <thead>
                  <tr>
                    <th>${bi('日期', 'Date')}</th><th>${bi('時間', 'Time')}</th><th>${bi('類型', 'Type')}</th><th>${bi('國家', 'Country')}</th>
                    <th class="num">${bi('用量', 'Usage')}</th><th class="bar-cell">${bi('分佈', 'Share')}</th><th class="num">${bi('佔比', 'Percent')}</th><th>${bi('狀態', 'Status')}</th>
                  </tr>
                </thead>
                <tbody>
${body}
                </tbody>
              </table>
            </div>
          </div>
        </div>`;
}

/**
 * Daily usage: one row per day, oldest first, each carrying its own records.
 *
 * This is the only place the records live now. A fixed table below the chart put
 * them hundreds of rows away from the bar being pointed at, which made "hover a
 * day to see its records" impossible to read.
 */
/**
 * Group the days into months, oldest first, keeping the order the flat chart used.
 *
 * A six month report is one bar per day, so the list alone is several screens.
 * Grouping does not change a single row inside a month; it only gives the report
 * something to collapse, and a place to put the totals that a closed group would
 * otherwise hide.
 */
function groupByMonth(days) {
  const groups = [];
  const sorted = days.slice().sort((a, b) => (a.dateIso < b.dateIso ? -1 : 1));
  for (const day of sorted) {
    const key = String(day.dateIso || '').slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.days.push(day);
    else groups.push({ key, days: [day] });
  }
  return groups;
}

/**
 * One month of the daily chart: a header with the month's totals, then the days.
 *
 * Every month starts closed, so the whole window reads as a handful of lines.
 * The header therefore has to carry what the closed group hides: the total, that
 * total against the busiest month, the day count and the daily average, which is
 * the summary a separate table used to provide.
 */
function renderMonth(analysis, group, rowsByDay, maxDayMb, maxMonthMb) {
  const id = `${analysis.scope || 'account'}-month-${group.key}`;
  const totalMb = group.days.reduce((sum, day) => sum + day.mb, 0);
  const avgMb = group.days.length ? totalMb / group.days.length : 0;
  const heavy = group.days.filter((day) => day.heavy).length;
  const width = maxMonthMb > 0 ? Math.max(2, (totalMb / maxMonthMb) * 100) : 0;
  const [year, month] = group.key.split('-');

  const label = bi(`${year} 年 ${Number(month)} 月`, group.key);
  const meta = bi(
    `${fmtInt(group.days.length)} 天 · 均 ${fmtMb(avgMb)}/天`,
    `${fmtInt(group.days.length)} day${group.days.length === 1 ? '' : 's'} · avg ${fmtMb(avgMb)}/day`
  );
  const days = group.days
    .map((day) => renderDay(analysis, day, rowsByDay.get(day.dateIso) || [], maxDayMb))
    .join('\n');

  return `        <div class="month" data-month="${esc(group.key)}">
          <button type="button" class="month-head" aria-expanded="false" aria-controls="${esc(id)}">
            <span class="month-chevron" aria-hidden="true"></span>
            <span class="month-name">${label}</span>
            <span class="month-total">${esc(fmtMb(totalMb))}</span>
            <span class="month-track"><span class="month-bar" style="width:${width.toFixed(2)}%"></span></span>
            <span class="month-meta">${meta}${heavy ? ` <em>⚑ ${heavy}</em>` : ''}</span>
          </button>
          <div class="month-body" id="${esc(id)}">
${days}
          </div>
        </div>`;
}

function renderDailyUsage(analysis) {
  const days = analysis.days;
  if (!days.length) {
    return `      <p class="empty">${bi('沒有符合條件的資料可繪製圖表。', 'No matching records to chart.')}</p>`;
  }

  const byDay = new Map();
  for (const row of analysis.kept) {
    if (!byDay.has(row.dateIso)) byDay.set(row.dateIso, []);
    byDay.get(row.dateIso).push(row);
  }

  // Bars stay scaled against the busiest day of the whole report, not of their
  // month, so two months can still be compared while both are open.
  const max = Math.max(...days.map((d) => d.mb), 0) || 1;
  const groups = groupByMonth(days);
  const maxMonthMb = Math.max(...groups.map((g) => g.days.reduce((sum, d) => sum + d.mb, 0)), 0) || 1;
  const blocks = groups
    .map((group) => renderMonth(analysis, group, byDay, max, maxMonthMb))
    .join('\n');

  const note =
    analysis.config.highlightDayMb > 0
      ? bi(
          `⚑ = 當日總量 > ${analysis.config.highlightDayMb} MB（單筆 > ${analysis.config.highlightMb} MB 的記錄另外在明細表標示）。`,
          `⚑ = a day totalling more than ${analysis.config.highlightDayMb} MB (records above ${analysis.config.highlightMb} MB are marked separately in the detail table).`
        )
      : bi(
          `⚑ = 當日有單筆 > ${analysis.config.highlightMb} MB 的記錄。`,
          `⚑ = a single record above ${analysis.config.highlightMb} MB that day.`
        );

  return `      <div class="chart">
${blocks}
      </div>
      <p class="foot-note">${note}</p>`;
}

/**
 * Links between this report and the frozen copies of older ones.
 *
 * Every href is absolute (built from the site's own address) and the frozen copy
 * is a byte for byte copy of the report that was published on the day it was
 * frozen, so the same markup works from the site root and from inside the archive
 * directory without either page needing to know where it is.
 */
function renderArchiveNav(nav) {
  const entries = (nav && nav.entries) || [];
  if (!entries.length) return '';

  const links = [
    `        <a class="archive-link is-current" href="${esc(nav.currentHref || './')}">${bi(
      '最新報告',
      'Current report'
    )}</a>`,
  ].concat(
    entries.map((entry) => {
      // The period is what the reader cares about; the file name and the freeze
      // date go in the tooltip so the line stays short.
      const label = entry.from && entry.to ? `${entry.from} → ${entry.to}` : entry.file;
      return `        <a class="archive-link" href="${esc(entry.href)}" title="${esc(
        `${entry.file}${entry.frozenAt ? ` (${entry.frozenAt})` : ''}`
      )}">${bi(label, label)}</a>`;
    })
  );

  return `    <nav class="archive-nav">
      <span class="title">${bi('報告存檔（Kogan 已不再顯示的期間）', 'Report archive (periods Kogan no longer shows)')}</span>
${links.join('\n')}
    </nav>`;
}

/** 2026-10-06 -> 06/10/2026 */
function isoToDisplayDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
}

/**
 * Cumulative usage as a line chart, with the current rate projected forward.
 *
 * X is the date and Y is the cumulative usage. The solid line is what was
 * actually recorded, the dashed line carries the average daily rate of the
 * observed period forward to the projection date (the plan expiry by default).
 * Everything is inline SVG, so the report stays a single offline file.
 */
function renderUsageChart(analysis) {
  const p = analysis.projection;
  if (!p || p.points.length === 0) return '';

  const W = 880;
  const H = 300;
  const pad = { top: 16, right: 104, bottom: 38, left: 72 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const t0 = isoToUtc(p.firstIso);
  const tLast = isoToUtc(p.lastIso);
  const tEnd = Math.max(tLast, isoToUtc(p.untilIso));
  const span = tEnd - t0 || 1;
  const yTop = Math.max(p.projectedTotalMb, p.totalMb) * 1.08 || 1;

  const X = (ts) => pad.left + ((ts - t0) / span) * plotW;
  const Y = (mb) => pad.top + plotH - (Math.max(0, mb) / yTop) * plotH;

  const marks = [];
  for (let i = 0; i <= 4; i += 1) {
    const value = (yTop / 4) * i;
    const y = Y(value);
    marks.push(
      `<line class="grid" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${(pad.left + plotW).toFixed(1)}" y2="${y.toFixed(1)}"/>`,
      `<text class="axis-label" x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(fmtMb(value))}</text>`
    );
  }
  for (let i = 0; i <= 6; i += 1) {
    const ts = t0 + (span / 6) * i;
    const x = X(ts);
    marks.push(
      `<line class="grid grid--v" x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${(pad.top + plotH).toFixed(1)}"/>`,
      `<text class="axis-label" x="${x.toFixed(1)}" y="${H - 14}" text-anchor="middle">${esc(isoToShortDisplay(utcToIso(ts)))}</text>`
    );
  }

  const points = p.points.map(
    (pt) => `${X(isoToUtc(pt.dateIso)).toFixed(1)},${Y(pt.cumulativeMb).toFixed(1)}`
  );
  const line = `M ${points.join(' L ')}`;
  const area = `${line} L ${X(tLast).toFixed(1)},${Y(0).toFixed(1)} L ${X(t0).toFixed(1)},${Y(0).toFixed(1)} Z`;
  const dots = p.points
    .map(
      (pt) =>
        `<circle class="actual-dot" cx="${X(isoToUtc(pt.dateIso)).toFixed(1)}" cy="${Y(pt.cumulativeMb).toFixed(1)}" r="2.4"/>`
    )
    .join('');

  let projected = '';
  if (p.remainingDays > 0) {
    const xEnd = X(tEnd);
    const yStart = Y(p.totalMb);
    const yEnd = Y(p.projectedTotalMb);
    projected = [
      `<line class="proj-line" x1="${X(tLast).toFixed(1)}" y1="${yStart.toFixed(1)}" x2="${xEnd.toFixed(1)}" y2="${yEnd.toFixed(1)}"/>`,
      `<circle class="proj-dot" cx="${xEnd.toFixed(1)}" cy="${yEnd.toFixed(1)}" r="3.5"/>`,
      `<text class="proj-label" x="${(xEnd + 9).toFixed(1)}" y="${(yEnd + 4).toFixed(1)}">${esc(fmtMb(p.projectedTotalMb))}</text>`,
    ].join('');
  }

  const until = isoToDisplayDate(p.untilIso);
  const caption =
    p.remainingDays > 0
      ? bi(
          `實際區間 ${isoToDisplayDate(p.firstIso)}–${isoToDisplayDate(p.lastIso)}（${p.spanDays} 天），平均 ${fmtMb(
            p.avgPerDayMb
          )}/天；依此速率到 ${until} 約 ${fmtMb(p.projectedTotalMb)}。`,
          `Observed ${isoToDisplayDate(p.firstIso)}-${isoToDisplayDate(p.lastIso)} (${
            p.spanDays
          } days), averaging ${fmtMb(p.avgPerDayMb)}/day; at that rate about ${fmtMb(
            p.projectedTotalMb
          )} by ${until}.`
        )
      : bi(
          `實際區間 ${isoToDisplayDate(p.firstIso)}–${isoToDisplayDate(p.lastIso)}（${p.spanDays} 天），合計 ${fmtMb(p.totalMb)}。`,
          `Observed ${isoToDisplayDate(p.firstIso)}-${isoToDisplayDate(p.lastIso)} (${
            p.spanDays
          } days), ${fmtMb(p.totalMb)} in total.`
        );

  return `      <div class="line-chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="cumulative usage and projection">
          ${marks.join('\n          ')}
          <path class="actual-area" d="${area}"/>
          <path class="actual-line" d="${line}"/>
          ${dots}
          ${projected}
        </svg>
        <div class="legend">
          <span><i class="swatch swatch--actual"></i>${bi('實際累積用量', 'Actual cumulative usage')}</span>
          ${
            p.remainingDays > 0
              ? `<span><i class="swatch swatch--proj"></i>${bi(
                  '依目前平均速率投射',
                  'Projected at the current average rate'
                )}</span>`
              : ''
          }
        </div>
        <p class="foot-note">${caption}</p>
      </div>`;
}

function footerMbFrom(footer) {
  if (!footer || footer.dataAmount === null || footer.dataAmount === undefined) return null;
  const unit = String(footer.dataUnit || 'MB').toUpperCase();
  const factor = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024, TB: 1048576 }[unit];
  return factor === undefined ? null : footer.dataAmount * factor;
}

function renderRules(analysis) {
  const s = analysis.stats;
  const cfg = analysis.config;
  const footerMb = footerMbFrom(analysis.footer);

  let checkValue;
  let checkNote;

  if (footerMb === null) {
    checkValue = `<span class="check--warn">${bi('頁尾未提供合計，無法交叉比對', 'No footer total to compare against')}</span>`;
    checkNote = bi('此頁面沒有 Charged 頁尾，略過交叉比對', 'This page has no Charged footer, cross-check skipped');
  } else {
    const diff = s.rawTotalMb - footerMb;
    const tolerance = Math.max(0.05, Number(s.roundingErrorMb) || 0, Math.abs(footerMb) * 0.0005);
    checkValue =
      Math.abs(diff) <= tolerance
        ? `<span class="check">${bi('✓ 與頁面頁尾一致', '✓ Matches the page footer')}</span>`
        : `<span class="check--warn">${bi(
            `⚠ 與頁尾差異 ${fmtMb(Math.abs(diff))}`,
            `⚠ Differs from footer by ${fmtMb(Math.abs(diff))}`
          )}</span>`;
    checkNote = bi(
      `頁尾標示 ${analysis.footer.dataText || ''}，本報告 ${fmtMb(s.rawTotalMb)}；差異 ${fmtMb(
        Math.abs(diff)
      )}，屬顯示值四捨五入範圍`,
      `Footer shows ${analysis.footer.dataText || ''}, this report ${fmtMb(
        s.rawTotalMb
      )}; the ${fmtMb(Math.abs(diff))} difference is display rounding`
    );
  }

  const extras = [];
  if (s.duplicateCount) {
    extras.push(bi(`移除重複列 ${fmtInt(s.duplicateCount)} 筆`, `${fmtInt(s.duplicateCount)} duplicate rows removed`));
  }
  if (s.invalidCount) {
    extras.push(bi(`無法解析的列 ${fmtInt(s.invalidCount)} 筆`, `${fmtInt(s.invalidCount)} unparsable rows`));
  }
  if (s.voiceCount) {
    extras.push(
      bi(
        `另有通話記錄 ${fmtInt(s.voiceCount)} 筆（合計 ${fmtDuration(s.voiceSeconds)}），未列入數據統計`,
        `${fmtInt(s.voiceCount)} call records (${fmtDuration(s.voiceSeconds)}) are excluded from the data totals`
      )
    );
  }
  if (s.smsCount) {
    extras.push(
      bi(
        `另有 SMS/MMS ${fmtInt(s.smsCount)} 筆，未列入數據統計`,
        `${fmtInt(s.smsCount)} SMS/MMS records are excluded from the data totals`
      )
    );
  }
  if (s.otherCount) {
    extras.push(bi(`其他類型記錄 ${fmtInt(s.otherCount)} 筆`, `${fmtInt(s.otherCount)} other records`));
  }

  const byteNote =
    cfg.mbBase === 1048576
      ? bi(
          '顯示為 B 的記錄以 1024 進位換算，與頁尾合計一致',
          'Rows shown as B are converted with 1024-based units to match the footer'
        )
      : bi('顯示為 B 的記錄以 1000 進位換算', 'Rows shown as B are converted with 1000-based units');

  return `      <h3 class="block-title">${bi('清理規則與資料品質', 'Cleanup rules & data quality')}</h3>
      <div class="rules">
        <div class="rule"><span class="k">${bi('忽略門檻', 'Ignore threshold')}</span><span class="v">${bi(
          `< ${cfg.minMb} MB`,
          `< ${cfg.minMb} MB`
        )}</span><div class="note">${bi(
          `已忽略 ${fmtInt(s.ignoredCount)} 筆，合計 ${fmtMb(s.ignoredMb)}`,
          `${fmtInt(s.ignoredCount)} records ignored, ${fmtMb(s.ignoredMb)} total`
        )}</div></div>
        <div class="rule"><span class="k">${bi('Highlight 門檻', 'Highlight threshold')}</span><span class="v">${bi(
          `> ${cfg.highlightMb} MB`,
          `> ${cfg.highlightMb} MB`
        )}</span><div class="note">${bi(
          `已標記 ${fmtInt(s.highlightedCount)} 筆，合計 ${fmtMb(s.highlightedMb)}${
            cfg.highlightDayMb > 0
              ? `；另有 ${fmtInt(s.heavyDays)} 天當日總量 > ${cfg.highlightDayMb} MB（每日圖標記 ⚑）`
              : ''
          }`,
          `${fmtInt(s.highlightedCount)} records flagged, ${fmtMb(s.highlightedMb)} total${
            cfg.highlightDayMb > 0
              ? `; ${fmtInt(s.heavyDays)} day(s) went above ${cfg.highlightDayMb} MB in total and are flagged in the daily chart`
              : ''
          }`
        )}</div></div>
        <div class="rule"><span class="k">${bi('位元組換算', 'Byte conversion')}</span><span class="v">${bi(
          `1 MB = ${fmtInt(cfg.mbBase)} bytes`,
          `1 MB = ${fmtInt(cfg.mbBase)} bytes`
        )}</span><div class="note">${byteNote}</div></div>
        <div class="rule"><span class="k">${bi('原始資料合計', 'Raw data total')}</span><span class="v">${esc(
    fmtMb(s.rawTotalMb)
  )}</span><div class="note">${bi(
    `${fmtInt(s.rawCount)} 筆數據記錄（過濾前）`,
    `${fmtInt(s.rawCount)} data records before filtering`
  )}</div></div>
        <div class="rule"><span class="k">${bi('頁尾交叉比對', 'Footer cross-check')}</span><span class="v">${checkValue}</span><div class="note">${checkNote}</div></div>
      </div>
${extras.length ? `      <p class="foot-note">${extras.join('<span class="i18n-zh">・</span><span class="i18n-en"> &middot; </span>')}。</p>\n` : ''}`;
}

function renderAccountSection(analysis, index, labelOptions, hideNames) {
  const number = accountLabel(analysis, index, labelOptions);
  const owner = ownerLabel(analysis, hideNames);
  // With an owner name the phone number becomes a quieter suffix.
  const heading = owner ? `${esc(owner)}<span class="acct-num">${esc(number)}</span>` : esc(number);
  const period = periodLabel(analysis);
  const type = typeLabel(analysis);
  const range =
    analysis.stats.firstDate && analysis.stats.lastDate
      ? `${analysis.stats.firstDate} → ${analysis.stats.lastDate}`
      : '—';

  return `    <section class="account" id="${esc(analysis.scope)}">
      <div class="account-head">
        <h2>${heading}</h2>
        <span class="pill pill--accent">${bi(period.zh, period.en)}</span>
        <span class="pill">${esc(type)}</span>
        ${
          analysis.stats.highlightedCount
            ? `<span class="pill pill--accent">${bi(
                `${fmtInt(analysis.stats.highlightedCount)} 筆高用量`,
                `${fmtInt(analysis.stats.highlightedCount)} high-usage`
              )}</span>`
            : ''
        }
      </div>
      <p class="account-sub">${bi('資料範圍：', 'Range: ')}${esc(range)}<span class="i18n-zh">　·　</span><span class="i18n-en"> &middot; </span>${bi(
    '來源頁面：',
    'Source page: '
  )}accounts.koganmobile.com.au/service/usage</p>
${renderSummaryCards(analysis)}
      <h3 class="block-title">${bi('每日用量', 'Daily usage')}<span class="block-hint">${bi(
        '展開月份，再點日期看當日明細（再點一次收起）',
        'Open a month, then click a day for its records (click again to close)'
      )}</span></h3>
${renderDailyUsage(analysis)}
      <h3 class="block-title">${bi('累積用量與投射', 'Cumulative usage and projection')}</h3>
${renderUsageChart(analysis)}
${renderRules(analysis)}
    </section>`;
}

function renderOverview(analyses, labelOptions, hideNames) {
  if (analyses.length < 2) return '';
  const hasOwners = !hideNames && analyses.some((a) => String(a.owner || '').trim());
  // A projection column only makes sense when there is a projection to show.
  const projected = analyses.filter((a) => a.projection);
  const projectUntil = projected.length ? isoToDisplayDate(projected[0].projection.untilIso) : '';
  const totals = analyses.reduce(
    (acc, a) => ({
      mb: acc.mb + a.stats.totalMb,
      kept: acc.kept + a.stats.keptCount,
      ignored: acc.ignored + a.stats.ignoredCount,
      ignoredMb: acc.ignoredMb + a.stats.ignoredMb,
      high: acc.high + a.stats.highlightedCount,
      highMb: acc.highMb + a.stats.highlightedMb,
    }),
    { mb: 0, kept: 0, ignored: 0, ignoredMb: 0, high: 0, highMb: 0 }
  );

  const rows = analyses
    .map(
      (a, i) => `          <tr>
            ${hasOwners ? `<td>${esc(String(a.owner || '').trim() || '—')}</td>` : ''}
            <td><a href="#${esc(a.scope)}">${esc(accountLabel(a, i, labelOptions))}</a></td>
            <td class="num strong">${esc(fmtMb(a.stats.totalMb))}</td>
            ${
              projectUntil
                ? `<td class="num">${
                    a.projection ? esc(fmtMb(a.projection.projectedTotalMb)) : '—'
                  }</td>`
                : ''
            }
            <td class="num">${esc(fmtInt(a.stats.keptCount))}</td>
            <td class="num">${
              a.stats.highlightedCount ? `<span class="badge">${esc(fmtInt(a.stats.highlightedCount))}</span>` : '0'
            }</td>
            <td class="num">${esc(fmtMb(a.stats.highlightedMb))}</td>
            <td class="num">${esc(fmtInt(a.stats.ignoredCount))}</td>
            <td class="num">${esc(fmtMb(a.stats.ignoredMb))}</td>
          </tr>`
    )
    .join('\n');

  return `    <section class="account">
      <div class="account-head"><h2>${bi('所有門號總覽', 'All accounts overview')}</h2><span class="pill">${bi(
    `${fmtInt(analyses.length)} 個門號`,
    `${fmtInt(analyses.length)} account${analyses.length === 1 ? '' : 's'}`
  )}</span></div>
      <div class="cards">
        <div class="card"><div class="label">${bi('合計用量', 'Combined usage')}</div><div class="value">${esc(
    fmtMb(totals.mb)
  )}</div><div class="sub">${bi(`${fmtInt(totals.kept)} 筆記錄`, `${fmtInt(totals.kept)} records`)}</div></div>
        <div class="card card--high"><div class="label">${bi('高用量合計', 'High usage')}</div><div class="value">${bi(
    `${fmtInt(totals.high)} 筆`,
    `${fmtInt(totals.high)}`
  )}</div><div class="sub">${esc(fmtMb(totals.highMb))}</div></div>
        <div class="card"><div class="label">${bi('已忽略合計', 'Ignored')}</div><div class="value">${bi(
    `${fmtInt(totals.ignored)} 筆`,
    `${fmtInt(totals.ignored)}`
  )}</div><div class="sub">${esc(fmtMb(totals.ignoredMb))}</div></div>
      </div>
      <div class="table-shell">
        <table class="overview-table">
          <thead>
            <tr>
              ${hasOwners ? `<th>${bi('姓名', 'Owner')}</th>` : ''}
              <th>${bi('門號', 'Account')}</th><th class="num">${bi('用量', 'Usage')}</th>${
    projectUntil
      ? `<th class="num">${bi(`投射至 ${projectUntil}`, `Projected by ${projectUntil}`)}</th>`
      : ''
  }<th class="num">${bi('筆數', 'Records')}</th>
              <th class="num">${bi('高用量', 'High usage')}</th><th class="num">${bi(
    '高用量合計',
    'High total'
  )}</th><th class="num">${bi('已忽略', 'Ignored')}</th><th class="num">${bi('忽略合計', 'Ignored total')}</th>
            </tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>
      ${
        projectUntil
          ? `<p class="foot-note">${bi(
              `投射值＝把觀測期間的平均每日用量直線延伸到 ${projectUntil}（方案到期日）。樣本天數越少，預估越粗略。`,
              `Projected = the average daily usage of the observed period carried straight to ${projectUntil} (the plan expiry). The fewer days observed, the rougher the estimate.`
            )}</p>`
          : ''
      }
    </section>`;
}

/** Build the complete standalone HTML report. */
function renderReport({
  analyses,
  generatedAt,
  archiveNav = null,
  settings = {},
  sourceLabel = '',
  lang = DEFAULT_LANG,
  redact = false,
  hideNames = false,
  maskNumbers = false,
}) {
  const labelOptions = { redact, maskNumbers };
  const body = analyses.map((a, i) => renderAccountSection(a, i, labelOptions, hideNames)).join('\n');
  const defaultLang = normalizeLang(lang) || DEFAULT_LANG;

  const onlyAccount = accountLabel(analyses[0], 0, labelOptions);
  const titleZh =
    analyses.length === 1
      ? `Kogan Mobile 數據用量報告 - ${onlyAccount}`.trim()
      : 'Kogan Mobile 數據用量報告';
  const titleEn =
    analyses.length === 1
      ? `Kogan Mobile data usage report - ${onlyAccount}`.trim()
      : 'Kogan Mobile data usage report';

  // Identifies this generated file, so the language the reader picks is only
  // remembered for this report and never leaks into the next one.
  const reportId = String(generatedAt || '').replace(/[^0-9]/g, '').slice(0, 12) || 'report';

  return `<!DOCTYPE html>
<html lang="${defaultLang === 'en' ? 'en' : 'zh-Hant'}" class="no-js" data-lang="${defaultLang}" data-report-id="${esc(
    reportId
  )}" data-title-zh="${esc(
    titleZh
  )}" data-title-en="${esc(titleEn)}" data-count-zh="顯示 {shown} / {total} 筆" data-count-en="Showing {shown} / {total}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(defaultLang === 'en' ? titleEn : titleZh)}</title>
<style>
${STYLES}
</style>
</head>
<body>
  <header class="page-head">
    <div class="wrap">
      <div class="lang-switch">
        <button type="button" data-lang-btn="zh">中文</button>
        <button type="button" data-lang-btn="en">English</button>
      </div>
      <div class="brand"><span class="dot"></span><span class="txt">Kogan Mobile</span></div>
      <h1>${bi('數據用量報告', 'Data usage report')}</h1>
      <div class="meta">
        ${bi('產生時間：', 'Generated: ')}<strong>${esc(generatedAt)}</strong>
        ${sourceLabel ? `<span class="i18n-zh">　·　</span><span class="i18n-en"> &middot; </span>${bi('來源：', 'Source: ')}<strong>${esc(sourceLabel)}</strong>` : ''}
        ${settings.mbBase ? `<span class="i18n-zh">　·　</span><span class="i18n-en"> &middot; </span>1 MB = ${esc(fmtInt(settings.mbBase))} bytes` : ''}
        <br>${bi('清理規則：', 'Rules: ')}${bi(
    `忽略 < ${settings.minMb} MB、highlight > ${settings.highlightMb} MB`,
    `ignore < ${settings.minMb} MB, highlight > ${settings.highlightMb} MB`
  )}
      </div>
    </div>
  </header>
  <div class="wrap">
${renderArchiveNav(archiveNav)}
${renderOverview(analyses, labelOptions, hideNames)}
${body}
    <p class="page-foot">${bi(
      '此報告由 kogan-mobile-usage 自動產生・資料版權屬 Kogan Mobile・僅供個人用量分析參考',
      'Generated by kogan-mobile-usage - data belongs to Kogan Mobile - for personal usage analysis only'
    )}</p>
  </div>
  <script>
${SCRIPT}
  </script>
</body>
</html>
`;
}

module.exports = { renderReport, esc, bi, fmtMb, fmtInt, periodLabel, typeLabel, groupByMonth };
