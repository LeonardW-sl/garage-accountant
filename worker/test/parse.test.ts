import { describe, it, expect } from 'vitest';
import { normalize, cnToNumber, toFen, parsePlate, parseItem } from '../src/parse';

// The strings below are taken from the real-device probe run on the target
// vivo X30 with the Doubao input method, not invented.
describe('normalize', () => {
  it('strips the space Doubao inserts and the trailing 句号', () => {
    expect(normalize('皖 A12345。')).toBe('皖 A12345');
  });
  it('folds full-width digits and letters', () => {
    expect(normalize('皖Ａ１２３４５')).toBe('皖A12345');
  });
  it('collapses runs of whitespace', () => {
    expect(normalize('机油   滤芯，  收 60')).toBe('机油 滤芯 收 60');
  });
});

describe('cnToNumber', () => {
  it('reads plain digits', () => expect(cnToNumber('120')).toBe(120));
  it('reads 六十', () => expect(cnToNumber('六十')).toBe(60));
  it('reads 一百二 as 120', () => expect(cnToNumber('一百二')).toBe(120));
  it('reads 两百五十', () => expect(cnToNumber('两百五十')).toBe(250));
  it('reads 一千二百', () => expect(cnToNumber('一千二百')).toBe(1200));
  it('rejects non-numerals', () => expect(cnToNumber('机油')).toBeNull());
});

describe('toFen', () => {
  it('keeps money as integer fen', () => expect(toFen('120')).toBe(12000));
  it('handles jiao without float drift', () => expect(toFen(12.6)).toBe(1260));
  it('converts spoken amounts', () => expect(toFen('一百二')).toBe(12000));
});

describe('parsePlate', () => {
  it('handles the IME-inserted space', () => {
    expect(parsePlate('皖 A12345')).toBe('皖A12345');
  });
  it('finds a plate inside a sentence', () => {
    expect(parsePlate('这个车牌是皖A12345。')).toBe('皖A12345');
  });
  it('repairs O/I only in the tail', () => {
    expect(parsePlate('皖AO1I45')).toBe('皖A01145');
  });
  it('returns null when there is no plate', () => {
    expect(parsePlate('机油滤芯收60')).toBeNull();
  });
});

describe('parseItem', () => {
  it('splits cost and charge by keyword', () => {
    const r = parseItem('机油滤芯 成本 60 收 120');
    expect(r).toMatchObject({ spokenName: '机油滤芯', cost: 6000, charge: 12000 });
  });

  it('treats two bare numbers as cost-then-charge', () => {
    const r = parseItem('刹车片 80 150');
    expect(r).toMatchObject({ cost: 8000, charge: 15000 });
  });

  it('treats a lone number as the charge', () => {
    const r = parseItem('补胎 30');
    expect(r).toMatchObject({ spokenName: '补胎', cost: null, charge: 3000 });
  });

  it('picks up quantity with a unit word', () => {
    const r = parseItem('火花塞 4 个 成本 20 收 40');
    expect(r?.qty).toBe(4);
  });

  // The core product contract: a garbled name must never lose the numbers.
  it('keeps a misheard name verbatim and still gets the money right', () => {
    const r = parseItem('漆管片 成本 12 收 30');
    expect(r).toMatchObject({ spokenName: '漆管片', cost: 1200, charge: 3000 });
  });

  it('accepts fully spoken amounts', () => {
    const r = parseItem('轮胎 成本 两百五十 收 三百');
    expect(r).toMatchObject({ cost: 25000, charge: 30000 });
  });

  it('returns null on empty input', () => {
    expect(parseItem('   ')).toBeNull();
  });
});
