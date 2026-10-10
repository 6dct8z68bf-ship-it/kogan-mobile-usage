'use strict';

const { textOf, parseAttributes } = require('./html');

const TABLE_ID = 'service-usage-history';

function sliceTable(html, tableId = TABLE_ID) {
  const openRe = new RegExp(`<table\\b[^>]*id=["']${tableId}["'][^>]*>`, 'i');
  const open = openRe.exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const end = html.indexOf('</table>', start);
  if (end === -1) return null;
  return html.slice(start, end);
}

function extractRows(tableHtml) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(tableHtml)) !== null) {
    const cells = [];
    const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let cell;
    while ((cell = cellRe.exec(tr[1])) !== null) {
      cells.push({ tag: cell[1].toLowerCase(), text: textOf(cell[2]) });
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function extractSelect(html, selectId) {
  const re = new RegExp(`<select\\b[^>]*id=["']${selectId}["'][^>]*>([\\s\\S]*?)</select>`, 'i');
  const m = re.exec(html);
  if (!m) return null;
  const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let opt;
  let first = null;
  let selected = null;
  while ((opt = optRe.exec(m[1])) !== null) {
    const attrs = parseAttributes(`<option ${opt[1]}>`);
    const label = textOf(opt[2]);
    const value = attrs.value !== undefined ? attrs.value : label;
    const entry = { value, label };
    if (first === null) first = entry;
    if (Object.prototype.hasOwnProperty.call(attrs, 'selected')) selected = entry;
  }
  return selected || first;
}

function extractAccountLabel(html) {
  const m = /<span\b[^>]*class=["'][^"']*portlet__mobile[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(html);
  if (m) {
    const label = textOf(m[1]);
    if (label) return label;
  }
  const fallback = /<h4\b[^>]*class=["'][^"']*portlet__customer[^"']*["'][^>]*>([\s\S]*?)<\/h4>/i.exec(html);
  return fallback ? textOf(fallback[1]) : '';
}

/** Parse the footer "Charged:" row: "SMS: 9", "Data: 1105.16 MB", "$0.00". */
function extractFooter(rows) {
  const footerRow = rows.find((cells) => cells[0] && /^charged:?$/i.test(cells[0].text.trim()));
  if (!footerRow) return { smsCount: null, dataText: null, dataMb: null, chargedText: null };

  const joined = footerRow.map((c) => c.text).join(' ');
  const sms = /SMS:\s*([0-9]+)/i.exec(joined);
  const data = /Data:\s*([0-9]+(?:[.,][0-9]+)?)\s*(B|KB|MB|GB|TB)\b/i.exec(joined);
  const money = /\$[0-9]+(?:[.,][0-9]+)?/.exec(joined);

  return {
    smsCount: sms ? Number(sms[1]) : null,
    dataText: data ? `${data[1]} ${data[2]}` : null,
    dataAmount: data ? Number(String(data[1]).replace(',', '.')) : null,
    dataUnit: data ? data[2].toUpperCase() : null,
    chargedText: money ? money[0] : null,
  };
}

const EXPECTED_COLUMNS = ['Date', 'Time', 'Type', 'Country', 'Number', 'Duration/MB', 'Charged'];

/**
 * Turn the usage page HTML into structured data.
 * Returns { ok, account, columns, rows, footer, form, error, tableId }.
 * `error` is a stable code ('NOT_LOGGED_IN' / 'TABLE_NOT_FOUND') that the CLI
 * translates, so the parser itself stays language neutral.
 */
function parseUsageHtml(html, options = {}) {
  const tableId = options.tableId || TABLE_ID;
  const tableHtml = sliceTable(html, tableId);

  if (!tableHtml) {
    if (/id=["']login-form["']/.test(html)) {
      return {
        ok: false,
        error: 'NOT_LOGGED_IN',
        message: 'The page is still the sign-in page.',
      };
    }
    return {
      ok: false,
      error: 'TABLE_NOT_FOUND',
      tableId,
      message: `No <table id="${tableId}"> found in the HTML.`,
    };
  }

  const allRows = extractRows(tableHtml);
  const theadCells = allRows.find((cells) => cells[0] && cells[0].tag === 'th');
  const columns = theadCells ? theadCells.map((c) => c.text) : EXPECTED_COLUMNS.slice();

  const dataRows = [];
  for (const cells of allRows) {
    if (!cells.length || cells[0].tag !== 'td') continue;
    dataRows.push({
      date: (cells[0] || {}).text || '',
      time: (cells[1] || {}).text || '',
      type: (cells[2] || {}).text || '',
      country: (cells[3] || {}).text || '',
      number: (cells[4] || {}).text || '',
      durationMB: (cells[5] || {}).text || '',
      charged: (cells[6] || {}).text || '',
    });
  }

  return {
    ok: true,
    account: extractAccountLabel(html),
    columns,
    rows: dataRows,
    footer: extractFooter(allRows),
    form: {
      type: extractSelect(html, 'usage-history-form-type'),
      months: extractSelect(html, 'usage-history-form-months'),
    },
    note: (() => {
      const m = /<div\b[^>]*id=["']usage-history-note["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html);
      return m ? textOf(m[1]) : '';
    })(),
  };
}

module.exports = { parseUsageHtml, extractRows, sliceTable, extractSelect, extractAccountLabel, expectColumns: EXPECTED_COLUMNS };
