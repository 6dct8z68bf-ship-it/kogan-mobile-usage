'use strict';

/**
 * Mask a phone number for display, keeping the first and last three digits:
 *
 *   0400000123    -> 040****123
 *   0400 000 123  -> 040****123
 *   61400000012   -> 614*****012
 *
 * Anything that does not look like a phone number ("Account 1", "Internet") is
 * returned unchanged.
 */
function maskPhoneNumber(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || !/^[\d\s().+-]+$/.test(raw)) return raw;
  return `${digits.slice(0, 3)}${'*'.repeat(digits.length - 6)}${digits.slice(-3)}`;
}

module.exports = { maskPhoneNumber };
