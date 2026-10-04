/**
 * normalize.js — make NAP values and URLs comparable.
 *
 * Phones: keep digits, drop an extension ("ext 12", "x12"), drop a leading international
 * "00", and drop the North American trunk "1" from 11-digit numbers. Two numbers match
 * when the normalised digit strings are equal, or when one is a suffix of the other and
 * the shorter has at least 9 digits (a number written with and without its country code).
 *
 * Addresses are compared component by component (street, locality, region, postal code)
 * after lower-casing, removing accents and punctuation, and mapping common street-type,
 * unit and directional words to one spelling ("Street" → "st", "Suite"/"Unit"/"#" → "unit",
 * "Northwest" → "nw"). Region names map to postal abbreviations for Canada and the US.
 * Postal codes are compared without spaces.
 */

const STREET_WORDS = {
  street: 'st', st: 'st', avenue: 'ave', ave: 'ave', av: 'ave', road: 'rd', rd: 'rd',
  boulevard: 'blvd', blvd: 'blvd', drive: 'dr', dr: 'dr', trail: 'tr', tr: 'tr', trl: 'tr',
  crescent: 'cres', cres: 'cres', court: 'ct', ct: 'ct', place: 'pl', pl: 'pl', lane: 'ln',
  ln: 'ln', highway: 'hwy', hwy: 'hwy', parkway: 'pkwy', pkwy: 'pkwy', square: 'sq', sq: 'sq',
  terrace: 'terr', terr: 'terr', way: 'way', gate: 'gate', circle: 'cir', cir: 'cir',
  suite: 'unit', ste: 'unit', unit: 'unit', apt: 'unit', apartment: 'unit', '#': 'unit',
  northwest: 'nw', nw: 'nw', northeast: 'ne', ne: 'ne', southwest: 'sw', sw: 'sw',
  southeast: 'se', se: 'se',
};

const REGIONS = {
  alberta: 'ab', 'british columbia': 'bc', manitoba: 'mb', 'new brunswick': 'nb',
  'newfoundland and labrador': 'nl', 'nova scotia': 'ns', ontario: 'on',
  'prince edward island': 'pe', quebec: 'qc', saskatchewan: 'sk', 'northwest territories': 'nt',
  nunavut: 'nu', yukon: 'yt', alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar',
  california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl',
  georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia',
  kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md',
  massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo',
  montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj',
  'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd',
  ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri',
  'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut',
  vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi',
  wyoming: 'wy', 'district of columbia': 'dc',
};

/** Lower-case, strip accents, turn punctuation into spaces, collapse whitespace. */
export function foldText(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/#/g, ' # ')
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** @returns {string} digits only, see module docstring */
export function normalizePhone(raw) {
  let s = String(raw ?? '').toLowerCase();
  s = s.replace(/\s*(?:ext\.?|extension|x)\s*\d+\s*$/, '');
  let digits = s.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits;
}

export function phonesMatch(a, b) {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  if (x === '' || y === '') return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 9 && long.endsWith(short);
}

/**
 * Phone-number candidates in free text (7–15 digits with common separators).
 * @returns {string[]} raw matches
 */
export function findPhones(text) {
  const re = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g;
  const out = [];
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) out.push(m[0].trim());
  }
  return out;
}

export function normalizeStreet(s) {
  return foldText(s)
    .split(' ')
    .map((w) => STREET_WORDS[w] ?? w)
    .join(' ');
}

export function normalizeRegion(s) {
  const f = foldText(s);
  return REGIONS[f] ?? f;
}

export function normalizePostal(s) {
  return String(s ?? '').replace(/[\s-]+/g, '').toLowerCase();
}

export function normalizeName(s) {
  return foldText(s);
}

/**
 * Compare GBP address parts with a schema PostalAddress.
 * @returns {Array<{part:string, gbp:string, site:string, status:'match'|'mismatch'|'missing'}>}
 */
export function compareAddress(gbp, site) {
  const parts = [
    ['street', gbp.lines.join(' '), site?.street ?? '', normalizeStreet],
    ['locality', gbp.locality, site?.locality ?? '', foldText],
    ['region', gbp.region, site?.region ?? '', normalizeRegion],
    ['postalCode', gbp.postalCode, site?.postalCode ?? '', normalizePostal],
  ];
  return parts
    .filter(([, g]) => String(g).trim() !== '')
    .map(([part, g, s, fn]) => {
      if (String(s).trim() === '') return { part, gbp: g, site: s, status: 'missing' };
      return { part, gbp: g, site: s, status: fn(g) === fn(s) ? 'match' : 'mismatch' };
    });
}

/**
 * Normalise a URL for page ↔ location matching: lower-case host, drop "www.", default
 * ports, query string, fragment and trailing slash; http and https are treated as equal.
 * @returns {string|null}
 */
export function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '') || '';
    return `${host}${path}`;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err; // invalid URL
    return null;
  }
}
