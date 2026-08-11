/**
 * Runtime contract tests for index.html (the single-file PWA).
 *
 * Loads the real file into jsdom and drives the actual flow, so a passing test
 * means the app works in a browser-like environment — not that the source
 * merely "looks right".
 *
 * Two rules here are product contracts, not style preferences:
 *   1. The customer receipt must never reveal cost, shipping or profit.
 *   2. The app must load with zero uncaught errors — the end user cannot read
 *      an error message, so a thrown exception is a total failure for him.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(HERE, '..', 'index.html');

/**
 * Boot index.html in jsdom.
 * Returns the window plus every runtime error and every spoken phrase, so tests
 * can assert on what the user would hear as well as what he would see.
 */
function boot({ records = null, settings = null } = {}) {
  const errors = [];
  const spoken = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message)));

  const dom = new JSDOM(readFileSync(HTML, 'utf8'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://leonardw-sl.github.io/garage-accountant/',
    virtualConsole: vc,
    beforeParse(win) {
      win.addEventListener('error', (e) => errors.push(String(e.message)));
      if (records) win.localStorage.setItem('garage_records', JSON.stringify(records));
      if (settings) win.localStorage.setItem('garage_settings', JSON.stringify(settings));

      // Record what the app tries to say aloud.
      win.SpeechSynthesisUtterance = class {
        constructor(text) { this.text = text; }
      };
      win.speechSynthesis = {
        speak: (u) => spoken.push(u && u.text ? u.text : ''),
        cancel() {},
        getVoices: () => [{ lang: 'zh-CN', name: 'test' }],
      };
    },
  });

  return { win: dom.window, doc: dom.window.document, errors, spoken };
}

const $ = (doc, id) => doc.getElementById(id);
const activeViewId = (doc) => {
  const v = doc.querySelector('.view.active');
  return v ? v.id : null;
};

test('app boots with no uncaught runtime errors', async () => {
  const { errors } = boot();
  // init() speaks from inside a setTimeout, so the timer has to actually fire
  // before this assertion means anything.
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(errors, [], `boot threw: ${errors.join(' | ')}`);
});

test('every onclick handler in the markup is actually defined', () => {
  const { win, doc } = boot();
  const missing = new Set();
  for (const el of doc.querySelectorAll('[onclick]')) {
    for (const name of el.getAttribute('onclick').matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (typeof win[name[1]] !== 'function') missing.add(name[1]);
    }
  }
  assert.deepEqual([...missing], [], `handlers referenced but not defined: ${[...missing]}`);
});

test('functions called from JS at runtime are defined', () => {
  const { win } = boot();
  for (const name of ['speak', 'renderHistory', 'exportData', 'clearAllData', 'backupToWebdav', 'restoreFromWebdav']) {
    assert.equal(typeof win[name], 'function', `${name} is not defined`);
  }
});

test('start button switches to the guide view', () => {
  const { win, doc } = boot();
  win.startFlow();
  assert.equal(activeViewId(doc), 'guideView');
});

test('parses a plain spoken part line', () => {
  const { win } = boot();
  const r = win.parsePartText('排气歧管垫片 60 运费12');
  assert.equal(r.part, '排气歧管垫片');
  assert.equal(r.cost, 60);
  assert.equal(r.shipping, 12);
});

test('parses Chinese numerals', () => {
  const { win } = boot();
  const r = win.parsePartText('刹车片 六十');
  assert.equal(r.cost, 60, '六十 should parse as 60');
  assert.equal(r.part, '刹车片');
});

test('parses 一百二 as 120', () => {
  const { win } = boot();
  assert.equal(win.parsePartText('机油 一百二').cost, 120);
});

test('survives the IME quirks seen on the real device', () => {
  const { win } = boot();
  // Doubao IME inserts a space before the amount and a full-width period at the end.
  const r = win.parsePartText('机油滤芯 ￥35。');
  assert.equal(r.cost, 35);
  assert.equal(r.part, '机油滤芯');
});

test('keeps a misheard part name verbatim', () => {
  const { win } = boot();
  // ASR may garble the name; the numbers must still be right and the name kept
  // exactly as heard, because that is what gets read back aloud.
  const r = win.parsePartText('漆管片 12');
  assert.equal(r.part, '漆管片');
  assert.equal(r.cost, 12);
});

test('receipt never shows cost, shipping or profit to the customer', () => {
  const { win, doc } = boot({ settings: { shopName: '老王汽修' } });
  win.renderReceipt({
    id: 'r1', date: '2026-08-11', plate: '皖A12345', customer: '',
    receiptNo: 'GX20260811-001',
    items: [{ part: '刹车片', cost: 60, shipping: 12, totalCost: 72, finalPrice: 150 }],
    totalCost: 72, totalIncome: 150,
  });
  const text = $(doc, 'receiptPage').textContent;
  for (const banned of ['成本', '利润', '进价', '运费']) {
    assert.ok(!text.includes(banned), `receipt leaks "${banned}" to the customer:\n${text}`);
  }
  assert.ok(!text.includes('72'), `receipt leaks the cost figure 72:\n${text}`);
  assert.ok(text.includes('150'), 'receipt must show the amount actually charged');
});

test('receipt read-aloud never mentions cost or profit', () => {
  const { win, spoken } = boot();
  spoken.length = 0;
  win.renderReceipt({
    id: 'r1', date: '2026-08-11', plate: '皖A12345', customer: '', receiptNo: 'GX20260811-001',
    items: [{ part: '刹车片', cost: 60, shipping: 12, totalCost: 72, finalPrice: 150 }],
    totalCost: 72, totalIncome: 150,
  });
  const said = spoken.join(' ');
  assert.ok(said.length > 0, 'the receipt must be announced aloud');
  assert.ok(!said.includes('利润'), `spoken receipt mentions profit: ${said}`);
});

test('receipt numbers do not collide within the same day', () => {
  const { win } = boot();
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const no = win.genReceiptNo();
    assert.ok(!seen.has(no), `duplicate receipt number ${no}`);
    seen.add(no);
    // Simulate the record being stored, which is what a real save does.
    win.records.push({ id: String(i), receiptNo: no, date: '2026-08-11', items: [], totalCost: 0, totalIncome: 0 });
  }
});

test('a job logged after midnight local time is filed on the local date', () => {
  const { win } = boot();
  // 00:30 Beijing on the 12th is still 16:30 UTC on the 11th. Using a UTC date
  // would file the job on the wrong day and corrupt the daily takings.
  const local = win.todayStr(new Date('2026-08-11T16:30:00Z'));
  assert.equal(local, '2026-08-12');
});

test('settings persist to localStorage', () => {
  const { win, doc } = boot();
  $(doc, 'setShopName').value = '老王汽修';
  $(doc, 'setShopName').dispatchEvent(new win.Event('input', { bubbles: true }));
  const saved = JSON.parse(win.localStorage.getItem('garage_settings') || '{}');
  assert.equal(saved.shopName, '老王汽修');
});

test('history view renders stored jobs', () => {
  const records = [{
    id: 'r1', date: '2026-08-11', plate: '皖A12345', receiptNo: 'GX20260811-001',
    items: [{ part: '刹车片', cost: 60, shipping: 12, totalCost: 72, finalPrice: 150 }],
    totalCost: 72, totalIncome: 150,
  }];
  const { win, doc } = boot({ records });
  win.showView('historyView');
  const html = $(doc, 'historyList').textContent;
  assert.ok(html.includes('皖A12345'), `history should list the plate:\n${html}`);
});

test('no pricing formula remains', () => {
  const src = readFileSync(HTML, 'utf8');
  // Match identifiers on word boundaries: a bare substring search for
  // "rounding" also hits the word "surrounding" in a comment.
  for (const gone of ['markupRate', 'baseFee', 'calcRecommended', 'recommendedPrice', 'acceptRecommended']) {
    assert.ok(!new RegExp(`\\b${gone}\\b`).test(src), `pricing formula leftover: ${gone}`);
  }
  for (const gone of ['settings.rounding', '推荐价', '加价倍率', '基础费', '取整到']) {
    assert.ok(!src.includes(gone), `pricing formula leftover: ${gone}`);
  }
  // And the settings UI rows must be gone too.
  const { doc } = boot();
  for (const id of ['setMarkup', 'setBaseFee', 'setRounding']) {
    assert.equal($(doc, id), null, `settings row ${id} still in the DOM`);
  }
});

test('plate is cleaned of IME punctuation and spacing', () => {
  const { win, doc } = boot();
  win.startFlow();
  // The Doubao IME inserts a space after the province character and appends a
  // full-width period; both must be stripped before the plate is stored.
  $(doc, 'guideInput').value = '皖 A12345。';
  win.confirmPlate();
  assert.equal(win.flow.plate, '皖A12345');
});

test('plate keeps lowercase ASR output usable', () => {
  const { win, doc } = boot();
  win.startFlow();
  $(doc, 'guideInput').value = '皖a12345';
  win.confirmPlate();
  assert.equal(win.flow.plate, '皖A12345', 'plate letters should be upper-cased');
});

test('no blocking native dialogs', () => {
  const { win } = boot();
  // Assert on behaviour, not on the source text: a source grep also matches
  // confirmPlate/confirmPart and the comment explaining why confirm() is gone.
  let called = 0;
  win.confirm = () => { called++; return true; };
  win.alert = () => { called++; };
  win.prompt = () => { called++; return ''; };

  win.startFlow();
  win.document.getElementById('guideInput').value = '皖A12345';
  win.confirmPlate();
  win.document.getElementById('guideInput').value = '刹车片 六十 运费12';
  win.confirmPart();
  win.acceptPart();       // this used to fire a native confirm()
  win.goToPrice();
  win.document.getElementById('guideInput').value = '150';
  win.confirmPrice();
  win.acceptPrice();
  win.clearAllData();     // and so did this

  assert.equal(called, 0, 'a native dialog was opened; this user cannot read one');
});

test('receipt image capture works offline', () => {
  const src = readFileSync(HTML, 'utf8');
  assert.ok(!src.includes('cdn.jsdelivr.net'), 'runtime CDN fetch fails offline and in China');
});

test('manifest works from a GitHub Pages subdirectory', () => {
  const m = JSON.parse(readFileSync(resolve(HERE, '..', 'manifest.json'), 'utf8'));
  // The site is served from /garage-accountant/, so an absolute "/index.html"
  // points at the domain root and the install silently fails.
  assert.ok(!m.start_url.startsWith('/'), `start_url must be relative: ${m.start_url}`);
  for (const icon of m.icons) {
    assert.ok(!icon.src.startsWith('/'), `icon src must be relative: ${icon.src}`);
  }
});

test('service worker is registered so the app opens offline', () => {
  const src = readFileSync(HTML, 'utf8');
  assert.ok(src.includes('serviceWorker'), 'sw.js exists but was never registered');
});

test('a Chinese numeral inside a part name is not eaten as the price', () => {
  const { win } = boot();
  // These are real part names. Treating 三/四/二 as the amount replaces an 800
  // yuan cost with 3 — a silent, unnoticeable corruption of the ledger.
  for (const [text, name, cost] of [
    ['三元催化器 800', '三元催化器', 800],
    ['四轮定位 100', '四轮定位', 100],
    ['二保焊丝 五十', '二保焊丝', 50],
    ['三滤 一百五', '三滤', 150],
  ]) {
    const r = win.parsePartText(text);
    assert.equal(r.cost, cost, `${text} → cost ${r.cost}, expected ${cost}`);
    assert.equal(r.part, name, `${text} → name "${r.part}", expected "${name}"`);
  }
});

test('explicit 零 is not scaled up', () => {
  const { win } = boot();
  assert.equal(win.parsePartText('刹车油 一百零五').cost, 105);
  assert.equal(win.parsePartText('机油 一百零八').cost, 108);
  // The trailing-digit shorthand must still work.
  assert.equal(win.parsePartText('机油 一百二').cost, 120);
  assert.equal(win.parsePartText('机油 一百二十').cost, 120);
  assert.equal(win.parsePartText('机油 两千五').cost, 2500);
});

test('a quantity word is not mistaken for the price', () => {
  const { win } = boot();
  // "两个" is a count, "80" is the money.
  const r = win.parsePartText('刹车片两个一共80');
  assert.equal(r.cost, 80, `got ${r.cost}`);
});

test('the larger amount wins when a count precedes the price', () => {
  const { win } = boot();
  assert.equal(win.parsePartText('机油 5升 200').cost, 200);
  assert.equal(win.parsePartText('轮胎 四条 每条300').cost, 300);
});

test('块 after an amount means yuan, not a count', () => {
  const { win } = boot();
  // 块 is both a measure word and the colloquial word for yuan. When it follows
  // a numeral that is the only candidate, it is money — dropping it to 0 loses
  // the cost entirely, which is the worst outcome.
  assert.equal(win.parsePartText('皮带 十五块').cost, 15);
  assert.equal(win.parsePartText('垫片 六十块钱').cost, 60);
});

test('every toast is accompanied by speech', () => {
  const src = readFileSync(HTML, 'utf8');
  const lines = src.split('\n');
  const silent = [];
  lines.forEach((line, i) => {
    if (!/\btoast\(/.test(line)) return;
    if (/function toast/.test(line)) return;
    // He cannot read the toast, so a message with no spoken counterpart is
    // invisible to him — worst of all on a failure path, where silence reads
    // as success.
    const window = lines.slice(Math.max(0, i - 2), i + 4).join('\n');
    if (!/\bspeak\(/.test(window)) silent.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(silent, [], `toast with no speak():\n${silent.join('\n')}`);
});

test('money never serializes as null', () => {
  const { win } = boot();
  const r = win.parsePartText('说不清楚的东西');
  assert.equal(r.cost, 0, 'unparseable input must yield 0, never NaN');
  assert.ok(JSON.parse(JSON.stringify(r)).cost === 0, 'NaN would serialize to null and corrupt the ledger');
});
