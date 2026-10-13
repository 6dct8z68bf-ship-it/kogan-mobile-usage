'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The list of frozen reports that are published next to the current one.
 *
 * Kogan only ever hands back a moving window (1, 3 or 6 months), so the day that
 * leaves that window is gone from the site for good. Instead of carrying those
 * rows forward inside every report, this keeps the other answer: every few months
 * the workflow freezes a copy of the published report and keeps publishing it
 * alongside the current one. The old day lives in a file that never changes
 * again, and the two reports link to each other.
 *
 * This module owns the small index that describes those copies: which files
 * exist, what period each one covers, and when the next freeze is due. The
 * workflow reads it to know what to download from the live site before the next
 * deploy (the site is rebuilt from scratch on every deploy, so the frozen files
 * have to be carried along), and the report renders its navigation from it.
 *
 * The file looks like this:
 *
 *   {
 *     "version": 1,
 *     "anchor": "2026-10-06",
 *     "everyMonths": 5,
 *     "archives": [
 *       {
 *         "file": "usage-2027-03-06.html",
 *         "from": "2026-10-06",
 *         "to": "2027-03-06",
 *         "frozenAt": "2027-03-06"
 *       }
 *     ]
 *   }
 */

const INDEX_VERSION = 1;
const DEFAULT_EVERY_MONTHS = 5;

function text(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text(value));
}

/**
 * "2026-10-06" + 5 months -> "2027-03-06".
 *
 * A day that does not exist in the target month rolls over the way Date does
 * ("2026-08-31" + 6 months -> "2027-03-03"), which is only ever relevant if the
 * anchor is a month end.
 */
function addMonths(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(iso));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + Number(months), Number(m[3])));
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

function emptyIndex(options = {}) {
  return {
    version: INDEX_VERSION,
    anchor: isIsoDate(options.anchor) ? text(options.anchor) : null,
    everyMonths: Number(options.everyMonths) > 0 ? Number(options.everyMonths) : DEFAULT_EVERY_MONTHS,
    archives: [],
  };
}

/** Drop anything that is not a usable entry, so one bad row cannot break a run. */
function normaliseEntry(entry) {
  if (!entry || !text(entry.file)) return null;
  return {
    file: path.basename(text(entry.file)),
    from: isIsoDate(entry.from) ? text(entry.from) : null,
    to: isIsoDate(entry.to) ? text(entry.to) : null,
    frozenAt: isIsoDate(entry.frozenAt) ? text(entry.frozenAt) : null,
  };
}

function normalise(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.archives)) {
    throw new Error('the archive index has an unexpected shape');
  }
  if (Number(data.version) > INDEX_VERSION) {
    throw new Error(`the archive index is version ${data.version}, newer than this tool understands`);
  }
  return {
    version: INDEX_VERSION,
    anchor: isIsoDate(data.anchor) ? text(data.anchor) : null,
    everyMonths: Number(data.everyMonths) > 0 ? Number(data.everyMonths) : DEFAULT_EVERY_MONTHS,
    archives: data.archives.map(normaliseEntry).filter(Boolean),
  };
}

/**
 * Read the index. Returns null when there is none yet, and throws when the file
 * exists but cannot be understood: publishing a site without the frozen reports
 * would throw them away, so the run has to stop instead.
 */
function loadIndex(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return normalise(JSON.parse(raw));
}

function saveIndex(file, index) {
  const payload = {
    version: INDEX_VERSION,
    anchor: index.anchor || null,
    everyMonths: index.everyMonths || DEFAULT_EVERY_MONTHS,
    archives: index.archives
      .map(normaliseEntry)
      .filter(Boolean)
      .sort((a, b) => (String(a.frozenAt) < String(b.frozenAt) ? -1 : 1)),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 1)}\n`, 'utf8');
  return payload;
}

function listFiles(index) {
  return ((index && index.archives) || []).map((entry) => entry.file);
}

/** The newest data date any frozen report covers. */
function lastCoveredIso(index) {
  let newest = null;
  for (const entry of (index && index.archives) || []) {
    if (entry.to && (!newest || entry.to > newest)) newest = entry.to;
  }
  return newest;
}

/**
 * The date the next freeze is due: `everyMonths` after the newest data a frozen
 * report covers, or after the anchor while nothing has been frozen yet.
 *
 * Five months with a six month window is deliberate: each freeze reaches back a
 * month further than the previous one ended, so a run that is late (or a whole
 * month that was skipped) still overlaps instead of leaving a hole.
 */
function dueIso(index, options = {}) {
  const months = Number(options.everyMonths) > 0 ? Number(options.everyMonths) : (index && index.everyMonths) || DEFAULT_EVERY_MONTHS;
  const from = lastCoveredIso(index) || (options.anchor ? text(options.anchor) : null) || (index && index.anchor) || null;
  return isIsoDate(from) ? addMonths(from, months) : null;
}

function isDue(index, today, options = {}) {
  const due = dueIso(index, options);
  return Boolean(due) && text(today) >= due;
}

function hasFrozenOn(index, today) {
  return ((index && index.archives) || []).some((entry) => entry.frozenAt === text(today));
}

function addArchive(index, entry) {
  const next = index || emptyIndex();
  const clean = normaliseEntry(entry);
  if (!clean) throw new Error('an archive entry needs a file name');
  return {
    ...next,
    archives: next.archives.filter((existing) => existing.file !== clean.file).concat(clean),
  };
}

/**
 * `node src/archive-index.js list <file>` prints the files a run has to download
 * from the live site before it can publish again.
 */
function main(argv) {
  const [command, file] = argv;
  if (command !== 'list' || !file) {
    process.stdout.write('usage: node src/archive-index.js list <archives.json>\n');
    process.exitCode = command === undefined ? 0 : 1;
    return;
  }
  const index = loadIndex(file);
  for (const name of listFiles(index)) process.stdout.write(`${name}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  INDEX_VERSION,
  DEFAULT_EVERY_MONTHS,
  addMonths,
  isIsoDate,
  emptyIndex,
  normalise,
  loadIndex,
  saveIndex,
  listFiles,
  lastCoveredIso,
  dueIso,
  isDue,
  hasFrozenOn,
  addArchive,
};
