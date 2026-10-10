'use strict';

const SIZE_PATTERN = /^([0-9]+(?:[.,][0-9]+)?)\s*(B|KB|MB|GB|TB|PB|KIB|MIB|GIB|TIB|PIB)$/i;
const DURATION_PATTERN = /^[0-9]{1,3}:[0-9]{2}(?::[0-9]{2})?$/;

// Kogan converts byte-denominated rows with 1024-based units before adding them
// to the MB rows (verified against the page footer of four accounts), so byte
// rows are normalised with byteBase (default 1 MiB = 1,048,576 bytes).
const DEFAULT_BYTE_BASE = 1048576;

/**
 * Parse the "Duration/MB" cell.
 * Returns { kind: 'size', mb, bytes, unit, value } or
 * { kind: 'duration', seconds } or null.
 *
 * `mb` is the number the page displays and is what every threshold is
 * compared against:
 *   B   → bytes / byteBase
 *   KB  → / 1024        MB → as shown     GB → * 1024
 */
function parseDurationOrSize(raw, options = {}) {
  const byteBase = Number(options.mbBase) > 0 ? Number(options.mbBase) : DEFAULT_BYTE_BASE;
  const value = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!value) return null;

  if (DURATION_PATTERN.test(value)) {
    const parts = value.split(':').map(Number);
    const seconds = parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
    return { kind: 'duration', seconds, raw: value };
  }

  const m = SIZE_PATTERN.exec(value);
  if (!m) return null;

  const amount = Number(m[1].replace(',', '.'));
  const unit = m[2].toUpperCase();
  if (!Number.isFinite(amount)) return null;

  let mb;
  switch (unit) {
    case 'B':
      mb = amount / byteBase;
      break;
    case 'KB':
    case 'KIB':
      mb = amount / 1024;
      break;
    case 'MB':
    case 'MIB':
      mb = amount;
      break;
    case 'GB':
    case 'GIB':
      mb = amount * 1024;
      break;
    case 'TB':
    case 'TIB':
      mb = amount * 1024 * 1024;
      break;
    case 'PB':
    case 'PIB':
      mb = amount * 1024 * 1024 * 1024;
      break;
    default:
      return null;
  }

  return {
    kind: 'size',
    mb,
    bytes: unit === 'B' ? amount : mb * byteBase,
    unit,
    value: amount,
    raw: value,
  };
}

/** bytes -> the MB value the page would show. */
function toMb(bytes, mbBase = DEFAULT_BYTE_BASE) {
  return Number(bytes) / (Number(mbBase) > 0 ? Number(mbBase) : DEFAULT_BYTE_BASE);
}

module.exports = {
  parseDurationOrSize,
  toMb,
  SIZE_PATTERN,
  DEFAULT_BYTE_BASE,
};
