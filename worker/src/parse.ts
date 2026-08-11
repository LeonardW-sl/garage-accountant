/**
 * Parses text produced by an AI input method (豆包/通义) speaking into a field.
 *
 * Real device capture showed three things that break naive regexes:
 *   - a space is inserted after the province char: "皖 A12345"
 *   - a space appears before amounts: "成本 60"
 *   - a full-width 句号 is appended to the utterance
 * So every entry point normalizes first.
 */

const FULLWIDTH_DIGITS = /[０-９]/g;
const CN_PUNCT = /[，。、；：！？（）【】「」]/g;

/** Chinese numerals for amounts a mechanic actually speaks. */
const CN_NUM: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

export function normalize(raw: string): string {
  return raw
    .replace(FULLWIDTH_DIGITS, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(CN_PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Converts spoken Chinese amounts to a number.
 * Handles the forms heard in testing: 一百二 (=120), 六十 (=60), 两百五十 (=250).
 * Returns null when the text is not a pure Chinese numeral.
 */
export function cnToNumber(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  if (!/^[零一二两三四五六七八九十百千万]+$/.test(t)) return null;

  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of t) {
    if (ch in CN_NUM) {
      digit = CN_NUM[ch];
    } else if (ch === '十') {
      section += (digit || 1) * 10;
      digit = 0;
    } else if (ch === '百') {
      section += (digit || 1) * 100;
      digit = 0;
    } else if (ch === '千') {
      section += (digit || 1) * 1000;
      digit = 0;
    } else if (ch === '万') {
      total += (section + digit) * 10000;
      section = 0;
      digit = 0;
    }
  }
  let n = total + section + digit;

  // "一百二" means 120, not 102 — a trailing bare digit after 百/千 scales up.
  const m = t.match(/([百千])([零一二两三四五六七八九])$/);
  if (m) {
    const scale = m[1] === '百' ? 10 : 100;
    n = n - CN_NUM[m[2]] + CN_NUM[m[2]] * scale;
  }
  return n;
}

/** Yuan (possibly spoken) → integer fen. Money never lives in a float. */
export function toFen(input: string | number): number | null {
  if (typeof input === 'number') return Math.round(input * 100);
  const n = cnToNumber(normalize(String(input)));
  return n === null ? null : Math.round(n * 100);
}

const PROVINCES = '京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新';

/**
 * Extracts a license plate. Tolerates the space the IME inserts and the
 * O/0 + I/1 confusion inherent to both speech and OCR.
 */
export function parsePlate(raw: string): string | null {
  const s = normalize(raw).replace(/\s/g, '').toUpperCase();
  const re = new RegExp(`[${PROVINCES}][A-Z][A-Z0-9]{4,6}`);
  const m = s.match(re);
  if (!m) return null;
  // Only the province+letter prefix is trustworthy; the tail may hold O/I.
  return m[0].slice(0, 2) + m[0].slice(2).replace(/O/g, '0').replace(/I/g, '1');
}

export interface ParsedItem {
  spokenName: string;
  qty: number;
  cost: number | null;   // fen
  charge: number | null; // fen
}

const NUM_TOKEN = '(\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十百千万]+)';

/**
 * Parses one spoken line into an item.
 *
 * The contract that governs this whole feature: the part name is returned
 * verbatim and a failure to understand it never blocks the record. Worst case
 * the mechanic gets an item with a garbled name and correct numbers — which is
 * still a usable ledger entry, because he verifies by number, not by name.
 */
export function parseItem(raw: string): ParsedItem | null {
  const s = normalize(raw);
  if (!s) return null;

  let cost: number | null = null;
  let charge: number | null = null;
  let rest = s;

  const costRe = new RegExp(`(?:成本|进价|本钱|拿货|买[来的]?)\\s*${NUM_TOKEN}`);
  const chargeRe = new RegExp(`(?:收|卖|要|算|报|加|价)\\s*${NUM_TOKEN}`);

  const cm = rest.match(costRe);
  if (cm) {
    cost = toFen(cm[1]);
    rest = rest.replace(cm[0], ' ');
  }
  const gm = rest.match(chargeRe);
  if (gm) {
    charge = toFen(gm[1]);
    rest = rest.replace(gm[0], ' ');
  }

  let qty = 1;
  const qm = rest.match(new RegExp(`${NUM_TOKEN}\\s*(?:个|只|条|套|副|根|张|瓶|桶|升|斤|包)`));
  if (qm) {
    const q = cnToNumber(qm[1]);
    if (q && q > 0 && q < 1000) qty = q;
    rest = rest.replace(qm[0], ' ');
  }

  // Two bare numbers with no keyword: mechanics say cost first, then price.
  if (cost === null && charge === null) {
    const bare = rest.match(new RegExp(`${NUM_TOKEN}\\D+${NUM_TOKEN}`));
    if (bare) {
      cost = toFen(bare[1]);
      charge = toFen(bare[2]);
      rest = rest.replace(bare[0], ' ');
    } else {
      const one = rest.match(new RegExp(NUM_TOKEN));
      if (one) {
        charge = toFen(one[1]);
        rest = rest.replace(one[0], ' ');
      }
    }
  }

  const spokenName = rest.replace(/\s+/g, '').trim();
  if (!spokenName && cost === null && charge === null) return null;

  return { spokenName, qty, cost, charge };
}
