/**
 * Contract tests for the PWA <-> Worker sync mapping.
 *
 * The local ledger and the D1 schema disagree on almost everything: yuan floats
 * vs integer fen, ISO strings vs epoch ms, a free-text customer vs a foreign
 * key, and two local fields (receiptNo, date) that had no column at all. Every
 * one of those is a place where a round trip can silently lose or corrupt data,
 * which for this user means a receipt he cannot reproduce in an argument.
 *
 * So the rule these tests enforce is: push a record, pull it back, and get the
 * same ledger entry — same money to the fen, same receipt number, same day.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(HERE, '..', 'index.html');

function boot({ records = null, settings = null, fetchImpl = null } = {}) {
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
      win.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
      win.speechSynthesis = { speak: (u) => spoken.push(u?.text ?? ''), cancel() {}, getVoices: () => [] };
      if (fetchImpl) win.fetch = fetchImpl;
    },
  });
  return { win: dom.window, doc: dom.window.document, errors, spoken };
}

const SAMPLE = {
  id: '1786600000000_ab12',
  date: '2026-08-13',
  plate: '皖A12345',
  customer: '',
  receiptNo: 'GX20260813-001',
  items: [
    { part: '三元催化器', cost: 800, shipping: 12.5, totalCost: 812.5, finalPrice: 1200 },
    { part: '机油滤芯', cost: 35, shipping: 0, totalCost: 35, finalPrice: 81.78 },
  ],
  totalCost: 847.5,
  totalIncome: 1281.78,
  createdAt: '2026-08-13T09:15:00.000Z',
};

test('a device id is generated once and then reused', () => {
  const { win } = boot();
  const a = win.getDeviceId();
  const b = win.getDeviceId();
  assert.equal(a, b, 'device id must be stable across calls');
  assert.ok(a && a.length >= 8, `device id looks unusable: ${a}`);
  assert.equal(win.localStorage.getItem('garage_device_id'), a, 'device id must persist');
});

test('money converts to integer fen with no float drift', () => {
  const { win } = boot();
  assert.equal(win.toFen(812.5), 81250);
  assert.equal(win.toFen(1281.78), 128178);
  assert.equal(win.toFen(0.1 + 0.2), 30, '0.30000000000000004 must not become 3000000...');
  assert.equal(win.toFen(0), 0);
  assert.equal(win.toFen(undefined), 0, 'missing money must be 0, never NaN');
  assert.equal(win.fromFen(128178), 1281.78);
  assert.equal(win.fromFen(0), 0);
});

test('a local record maps onto the worker job payload', () => {
  const { win } = boot();
  const job = win.recordToJob(SAMPLE);

  assert.equal(job.id, SAMPLE.id);
  assert.ok(job.device_id, 'device_id is required by the worker');
  assert.equal(job.plate, '皖A12345');
  assert.equal(job.total_cost, 84750, '总成本 must be fen');
  assert.equal(job.total_charge, 128178, '实收 must be fen');
  assert.equal(typeof job.created_at, 'number', 'created_at must be epoch ms');
  assert.ok(job.created_at > 0);
  assert.equal(typeof job.updated_at, 'number');

  assert.equal(job.items.length, 2);
  const [a, b] = job.items;
  // The spoken name is the one field that must never be rewritten — it is what
  // gets read back aloud, and the schema comment says so explicitly.
  assert.equal(a.spoken_name, '三元催化器');
  assert.equal(a.cost, 80000);
  assert.equal(a.shipping, 1250);
  assert.equal(a.charge, 120000);
  assert.equal(a.seq, 0);
  assert.ok(a.id, 'each item needs a stable id');
  assert.equal(b.spoken_name, '机油滤芯');
  assert.equal(b.charge, 8178);
});

test('receiptNo and the local date survive the mapping', () => {
  const { win } = boot();
  const job = win.recordToJob(SAMPLE);
  const flat = JSON.stringify(job);
  // These two are customer-facing: the receipt number identifies the document
  // he handed over, and the date is the local calendar day the job was filed
  // under. Neither can be reconstructed reliably from created_at alone.
  assert.ok(flat.includes('GX20260813-001'), `receiptNo lost in mapping:\n${flat}`);
  assert.ok(flat.includes('2026-08-13'), `local date lost in mapping:\n${flat}`);
});

test('push then pull returns an identical ledger entry', () => {
  const { win } = boot();
  const job = win.recordToJob(SAMPLE);
  // Simulate the worker echoing back exactly what it stored, including the
  // snake_case rows D1 returns.
  const back = win.jobToRecord(job, job.items);

  assert.equal(back.id, SAMPLE.id);
  assert.equal(back.plate, SAMPLE.plate);
  assert.equal(back.receiptNo, SAMPLE.receiptNo, 'receipt number changed on round trip');
  assert.equal(back.date, SAMPLE.date, 'local date changed on round trip');
  assert.equal(back.totalCost, SAMPLE.totalCost, 'cost drifted on round trip');
  assert.equal(back.totalIncome, SAMPLE.totalIncome, 'income drifted on round trip');
  assert.equal(back.items.length, SAMPLE.items.length);
  for (let i = 0; i < SAMPLE.items.length; i++) {
    assert.equal(back.items[i].part, SAMPLE.items[i].part, `item ${i} name changed`);
    assert.equal(back.items[i].cost, SAMPLE.items[i].cost, `item ${i} cost changed`);
    assert.equal(back.items[i].shipping, SAMPLE.items[i].shipping, `item ${i} shipping changed`);
    assert.equal(back.items[i].finalPrice, SAMPLE.items[i].finalPrice, `item ${i} charge changed`);
  }
});

test('a pulled job merges by updated_at, newest wins', () => {
  const local = { ...SAMPLE, totalIncome: 100, updatedAt: 2000 };
  const { win } = boot({ records: [local] });

  // Older remote edit must not clobber the newer local one.
  win.mergeRemote([{ ...win.recordToJob(SAMPLE), updated_at: 1000, total_charge: 999900 }], []);
  assert.equal(win.records[0].totalIncome, 100, 'a stale remote edit overwrote newer local data');

  // Newer remote edit wins.
  win.mergeRemote([{ ...win.recordToJob(SAMPLE), updated_at: 9000, total_charge: 999900 }], []);
  assert.equal(win.records[0].totalIncome, 9999, 'a newer remote edit was ignored');
});

test('a soft-deleted remote job is removed locally', () => {
  const { win } = boot({ records: [SAMPLE] });
  const job = win.recordToJob(SAMPLE);
  win.mergeRemote([{ ...job, updated_at: Date.now(), deleted_at: Date.now() }], []);
  assert.equal(win.records.length, 0, 'a job deleted on another device must disappear here');
});

test('sync failure is non-fatal and spoken', async () => {
  const failing = () => Promise.reject(new Error('network down'));
  const { win, spoken } = boot({
    settings: { syncUrl: 'https://garage.20040114.xyz', syncToken: 't' },
    fetchImpl: failing,
  });
  spoken.length = 0;
  await win.syncNow();
  // He is offline in the workshop most of the day. A failed sync must never
  // lose the local ledger or throw, and he has to be told out loud.
  assert.ok(win.records, 'local records must survive a failed sync');
  assert.ok(spoken.join(' ').length > 0, 'a sync failure must be spoken');
});

test('a sync requested during an in-flight sync still happens', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = (url, opts) => {
    calls++;
    const body = { ok: true, written: 1, jobs: [], items: [], ts: Date.now() };
    // Hold the first request open so the second call overlaps it.
    const wait = calls <= 2 ? gate : Promise.resolve();
    return wait.then(() => ({ ok: true, status: 200, json: () => Promise.resolve(body) }));
  };
  const { win } = boot({
    records: [SAMPLE],
    settings: { syncUrl: 'https://example.test', syncToken: 't' },
    fetchImpl,
  });

  const first = win.syncNow(true);
  const second = win.syncNow(true);   // arrives while the first is still open
  release();
  const [a, b] = await Promise.all([first, second]);

  // Pressing the button after an auto-sync must not be a silent no-op: the
  // second request has to actually reach the server, or his newest job never
  // leaves the phone.
  assert.equal(a.ok, true, `first sync failed: ${JSON.stringify(a)}`);
  assert.notEqual(b.reason, 'busy', 'second sync was silently dropped');
  assert.equal(b.ok, true, `second sync failed: ${JSON.stringify(b)}`);
  assert.ok(calls >= 4, `expected both syncs to hit the network, saw ${calls} calls`);
});

test('sync is skipped cleanly when not configured', async () => {
  const { win } = boot();
  await win.syncNow();  // must not throw
  assert.ok(true);
});
