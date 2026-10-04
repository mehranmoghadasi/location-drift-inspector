/**
 * html.js — pull the two things the audit needs out of an HTML string, without a DOM:
 *   1. the JSON-LD blocks (<script type="application/ld+json">), parsed;
 *   2. the visible text (scripts, styles, templates, comments and <head> removed,
 *      block elements turned into line breaks, entities decoded) plus tel: link targets.
 *
 * Working on a string keeps the same code usable in the popup (rendered DOM serialised
 * with outerHTML), in the dashboard's batch scan (raw HTML from fetch), in the MV3
 * service worker (which has no DOMParser) and in Node tests.
 * Text hidden with CSS (display:none) cannot be detected from a string and is treated as
 * visible — see README "Limitations".
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•', hellip: '…',
};

/** Decode the HTML entities that occur in addresses, hours and phone numbers. */
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/**
 * @param {string} html
 * @returns {{blocks: Array<any>, errors: Array<{index:number, message:string}>}}
 */
export function extractJsonLd(html) {
  const blocks = [];
  const errors = [];
  const re = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  let index = 0;
  while ((m = re.exec(String(html))) !== null) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
    try {
      blocks.push(JSON.parse(raw));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      errors.push({ index, message: err.message });
    }
    index += 1;
  }
  return { blocks, errors };
}

const BLOCK_TAGS = 'address|article|aside|blockquote|br|dd|div|dl|dt|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

/**
 * @param {string} html
 * @returns {{text: string, lines: string[], telLinks: string[]}}
 */
export function visibleText(html) {
  let s = String(html);
  const telLinks = [];
  const telRe = /<a\b[^>]*\bhref\s*=\s*["']\s*tel:([^"']+)["']/gi;
  let t;
  while ((t = telRe.exec(s)) !== null) telLinks.push(decodeEntities(decodeURIComponentSafe(t[1].trim())));
  s = s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, ' ');
  const lines = decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[\t  ]+/g, ' ').trim())
    .filter((l) => l !== '');
  return { text: lines.join('\n'), lines, telLinks };
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
    return s;
  }
}
