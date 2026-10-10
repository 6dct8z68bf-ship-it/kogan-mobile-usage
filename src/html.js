'use strict';

const NAMED_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
};

/**
 * Decode HTML entities, including numeric forms such as &#160; and &#xNN;.
 */
function decodeEntities(input) {
  if (input === null || input === undefined) return '';
  return String(input).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

function stripTags(input) {
  return String(input === null || input === undefined ? '' : input).replace(/<[^>]*>/g, ' ');
}

/** Strip tags, decode entities, collapse whitespace. */
function textOf(input) {
  return decodeEntities(stripTags(input)).replace(/\s+/g, ' ').trim();
}

/** Collect the attributes of a tag into an object (double or single quoted). */
function parseAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] || '');
  }
  return attrs;
}

module.exports = { decodeEntities, stripTags, textOf, parseAttributes };
