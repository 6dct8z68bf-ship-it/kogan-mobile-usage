'use strict';

const { parseDurationOrSize, DEFAULT_BYTE_BASE } = require('./units');

// Unit-to-MB factors, used to estimate the rounding error of displayed values.
const UNIT_TO_MB = { B: 0, KB: 0.001, MB: 1, GB: 1000, TB: 1e6, PB: 1e9 };

/** 09/10/2026 -> { iso: '2026-10-09', display: '09/10/2026' }; also accepts 2026-10-09. */
function normaliseDate(raw) {
  const value = String(raw || '').trim();
  let m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(value);
  if (m) {
    const [, d, mo, y] = m;
    return {
      iso: `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`,
      display: `${d.padStart(2, '0')}/${mo.padStart(2, '0')}/${y}`,
    };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const [, y, mo, d] = m;
    return { iso: `${y}-${mo}-${d}`, display: `${d}/${mo}/${y}` };
  }
  return { iso: value, display: value };
}

/** Normalise 16:00:00 / 15:27 to HH:MM:SS and return a sortable key. */
function normaliseTime(raw) {
  const value = String(raw || '').trim();
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return { display: value, sort: value };
  const hh = m[1].padStart(2, '0');
  const mm = m[2];
  const ss = m[3] !== undefined ? m[3] : '00';
  return { display: `${hh}:${mm}:${ss}`, sort: `${hh}${mm}${ss}` };
}

function isDataRow(row) {
  return /data/i.test(row.type) || /^internet$/i.test(row.number.trim());
}

function rowKey(record) {
  return [record.dateIso, record.timeDisplay, record.type, record.country, record.number, record.raw].join('|');
}

/**
 * Turn parsed rows into report-ready data.
 *
 * options:
 *   mbBase        bytes per MB for byte rows (default 1048576)
 *   minMb         ignore records below this many MB (default 1)
 *   highlightMb   highlight records above this many MB (default 50)
 *   dedupe        drop exact duplicate rows (default true)
 */
function cleanUsage(parsed, options = {}) {
  const mbBase = Number(options.mbBase) > 0 ? Number(options.mbBase) : DEFAULT_BYTE_BASE;
  const minMb = Number.isFinite(Number(options.minMb)) ? Number(options.minMb) : 1;
  const highlightMb = Number.isFinite(Number(options.highlightMb)) ? Number(options.highlightMb) : 50;
  const dedupe = options.dedupe !== false;

  const dataRecords = [];
  const voiceRecords = [];
  const smsRecords = [];
  const otherRecords = [];
  const seen = new Set();
  let duplicateCount = 0;
  let invalidCount = 0;

  for (const row of parsed.rows) {
    const measure = parseDurationOrSize(row.durationMB, { mbBase });
    const date = normaliseDate(row.date);
    const time = normaliseTime(row.time);
    const base = {
      ...row,
      dateIso: date.iso,
      dateDisplay: date.display,
      timeDisplay: time.display,
      sortKey: `${date.iso.replace(/-/g, '')}${time.sort}`,
    };

    if (!measure) {
      if (/sms|mms/i.test(row.type)) {
        smsRecords.push({ ...base, kind: 'sms' });
        continue;
      }
      invalidCount += 1;
      otherRecords.push({ ...base, kind: 'unknown' });
      continue;
    }

    if (measure.kind === 'duration') {
      voiceRecords.push({ ...base, kind: 'duration', seconds: measure.seconds });
      continue;
    }

    if (!isDataRow(row)) {
      otherRecords.push({ ...base, kind: 'other', bytes: measure.bytes });
      continue;
    }

    const record = {
      ...base,
      kind: 'data',
      bytes: measure.bytes,
      mb: measure.mb,
      unit: measure.unit,
      rawAmount: measure.value,
    };

    if (dedupe) {
      const key = rowKey(record);
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
    }

    dataRecords.push(record);
  }

  const ignored = dataRecords.filter((r) => r.mb < minMb);
  const kept = dataRecords.filter((r) => r.mb >= minMb);
  for (const r of kept) {
    r.highlighted = r.mb > highlightMb;
  }

  kept.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));

  const highlighted = kept.filter((r) => r.highlighted);

  const totalMb = kept.reduce((sum, r) => sum + r.mb, 0);
  const ignoredMb = ignored.reduce((sum, r) => sum + r.mb, 0);
  const highlightedMb = highlighted.reduce((sum, r) => sum + r.mb, 0);
  const rawTotalMb = dataRecords.reduce((sum, r) => sum + r.mb, 0);

  for (const r of kept) {
    r.sharePct = totalMb > 0 ? (r.mb / totalMb) * 100 : 0;
  }

  const dailyMap = new Map();
  for (const r of kept) {
    if (!dailyMap.has(r.dateIso)) {
      dailyMap.set(r.dateIso, { dateIso: r.dateIso, dateDisplay: r.dateDisplay, mb: 0, count: 0, maxMb: 0, highlighted: 0 });
    }
    const day = dailyMap.get(r.dateIso);
    day.mb += r.mb;
    day.count += 1;
    day.maxMb = Math.max(day.maxMb, r.mb);
    if (r.highlighted) day.highlighted += 1;
  }
  const days = [...dailyMap.values()]
    .sort((a, b) => (a.dateIso < b.dateIso ? 1 : -1));

  const voiceSeconds = voiceRecords.reduce((sum, r) => sum + r.seconds, 0);
  const maxMb = kept.reduce((max, r) => Math.max(max, r.mb), 0);
  const avgMb = kept.length ? totalMb / kept.length : 0;

  // The page only shows two decimals per row while the footer total is computed
  // from more precise values, so the allowed difference is the sum of 0.005 per
  // rounded row plus a small margin.
  const roundingErrorMb = dataRecords.reduce(
    (sum, r) => sum + 0.005 * (UNIT_TO_MB[r.unit] !== undefined ? UNIT_TO_MB[r.unit] : 1),
    0
  );

  return {
    account: parsed.account,
    form: parsed.form,
    footer: parsed.footer,
    note: parsed.note,
    columns: parsed.columns,
    config: { mbBase, minMb, highlightMb, dedupe },
    kept,
    ignored,
    highlighted,
    days,
    voiceRecords,
    smsRecords,
    otherRecords,
    stats: {
      totalBytes: totalMb * mbBase,
      totalMb,
      rawTotalMb,
      rawCount: dataRecords.length,
      keptCount: kept.length,
      ignoredCount: ignored.length,
      ignoredMb,
      highlightedCount: highlighted.length,
      highlightedMb,
      highlightedSharePct: totalMb > 0 ? (highlightedMb / totalMb) * 100 : 0,
      ignoredSharePct: rawTotalMb > 0 ? (ignoredMb / rawTotalMb) * 100 : 0,
      duplicateCount,
      invalidCount,
      days: days.length,
      maxMb,
      avgMb,
      voiceCount: voiceRecords.length,
      voiceSeconds,
      smsCount: smsRecords.length,
      otherCount: otherRecords.length,
      roundingErrorMb,
      firstDate: kept.length ? kept[kept.length - 1].dateDisplay : null,
      lastDate: kept.length ? kept[0].dateDisplay : null,
    },
  };
}

module.exports = { cleanUsage, normaliseDate, normaliseTime, isDataRow };
