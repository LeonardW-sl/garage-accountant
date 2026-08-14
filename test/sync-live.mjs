/**
 * Drives the real PWA against a real Worker over real HTTP.
 *
 * The jsdom sync tests mock fetch, so they prove the mapping is self-consistent
 * but not that it matches what the Worker actually stores. This runs the app in
 * Chrome, points it at `wrangler dev`, and checks that a job recorded through
 * the UI comes back byte-identical after a wipe-and-pull — the scenario that
 * matters, because it is what happens when he loses the phone.
 *
 * Usage: node sync-live.mjs <baseUrl> <token>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import CDP from 'chrome-remote-interface';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BASE = process.argv[2];
const TOKEN = process.argv[3];
if (!BASE || !TOKEN) {
  console.error('usage: node sync-live.mjs <workerBaseUrl> <token>');
  process.exit(2);
}

const CDP_PORT = 9444;
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Serve the app over http so fetch/CORS behave like production.
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.png': 'image/png' };
const site = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const file = join(ROOT, path === '/' ? 'index.html' : path.slice(1));
  try {
    const body = readFileSync(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nope');
  }
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'garage-sync-'));
// The Worker only allows the production origin, which is correct — so rather
// than loosening CORS for the test, map that hostname to the local server and
// let the app run under its real origin. This exercises the deployed CORS rule
// instead of bypassing it.
const PROD_HOST = 'leonardw-sl.github.io';
const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars',
  `--host-resolver-rules=MAP ${PROD_HOST} 127.0.0.1:${site.address().port}`,
  `--unsafely-treat-insecure-origin-as-secure=http://${PROD_HOST}`,
], { stdio: 'ignore' });

let client;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await CDP.List({ port: CDP_PORT })).length) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  client = await CDP({ port: CDP_PORT });
  const { Page, Runtime } = client;
  await Promise.all([Page.enable(), Runtime.enable()]);

  const errors = [];
  Runtime.exceptionThrown((p) => errors.push(p.exceptionDetails?.exception?.description ?? 'unknown'));

  const evaluate = async (expr) => {
    const { result, exceptionDetails } = await Runtime.evaluate({
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed');
    return result.value;
  };

  await Page.navigate({ url: `http://${PROD_HOST}/index.html` });
  await Page.loadEventFired();
  await new Promise((r) => setTimeout(r, 600));

  // Point the app at the worker exactly as the settings screen would.
  await evaluate(`(() => {
    settings.syncUrl = ${JSON.stringify(BASE)};
    settings.syncToken = ${JSON.stringify(TOKEN)};
    localStorage.setItem('garage_settings', JSON.stringify(settings));
    localStorage.setItem('garage_device_id', 'dev-live-test');
    records = []; saveRecords();
    return true;
  })()`);

  // ---- record a job through the real UI flow ----
  await evaluate(`(() => {
    startFlow();
    document.getElementById('guideInput').value = '皖A66666';
    confirmPlate();
    document.getElementById('guideInput').value = '三元催化器 成本800 运费12.5';
    confirmPart(); acceptPart();
    addAnotherPart();
    document.getElementById('guideInput').value = '机油滤芯 三十五';
    confirmPart(); acceptPart();
    goToPrice();
    document.getElementById('guideInput').value = '一千二百';
    confirmPrice(); acceptPrice();
    return true;
  })()`);

  const local = await evaluate(`JSON.parse(JSON.stringify(records[0]))`);
  record('job recorded locally through the UI', !!local && local.items.length === 2,
    local ? `${local.plate} ¥${local.totalIncome} 成本¥${local.totalCost} ${local.receiptNo}` : 'none');

  // ---- push ----
  const push = await evaluate(`syncNow(true)`);
  record('push to the live worker succeeded', push && push.ok === true,
    push ? JSON.stringify(push) : 'no result');

  // ---- wipe the phone, then pull ----
  const restored = await evaluate(`(async () => {
    records = []; saveRecords();
    localStorage.setItem('garage_sync_since', '0');
    const out = await syncNow(true);
    return { out, count: records.length, first: records[0] ? JSON.parse(JSON.stringify(records[0])) : null };
  })()`);

  record('pull after a wipe restores the job', restored.count === 1,
    `${restored.count} record(s)`);

  const b = restored.first;
  if (b) {
    record('plate survived the round trip', b.plate === local.plate, `${local.plate} -> ${b.plate}`);
    record('receipt number survived', b.receiptNo === local.receiptNo, `${local.receiptNo} -> ${b.receiptNo}`);
    record('local date survived', b.date === local.date, `${local.date} -> ${b.date}`);
    record('income exact to the fen', b.totalIncome === local.totalIncome, `${local.totalIncome} -> ${b.totalIncome}`);
    record('cost exact to the fen', b.totalCost === local.totalCost, `${local.totalCost} -> ${b.totalCost}`);
    record('both items came back', (b.items || []).length === 2, `${(b.items || []).length} items`);
    const names = (b.items || []).map((i) => i.part).join(',');
    // The spoken name is what gets read back aloud; a rewrite here is a product
    // contract violation, not a cosmetic diff.
    record('spoken part names verbatim', names === '三元催化器,机油滤芯', names);
    const lineSum = (b.items || []).reduce((a, i) => a + i.finalPrice, 0);
    record('line items still sum to the charge',
      Math.abs(lineSum - b.totalIncome) < 0.005, `${lineSum} vs ${b.totalIncome}`);
    record('shipping preserved per item',
      b.items[0].shipping === local.items[0].shipping,
      `${local.items[0].shipping} -> ${b.items[0].shipping}`);
  } else {
    record('round-trip fields', false, 'nothing restored');
  }

  // ---- a stale replay must not clobber ----
  const stale = await evaluate(`(() => {
    if (!records.length) return 'no record to test';
    records[0].totalIncome = 1500;
    records[0].updatedAt = Date.now() + 60000;
    saveRecords();
    mergeRemote([{ id: records[0].id, updated_at: 1, total_charge: 100, created_at: 1 }], []);
    return records[0].totalIncome;
  })()`);
  record('a stale remote edit cannot overwrite newer local data', stale === 1500, `income=${stale}`);

  record('no uncaught errors during sync', errors.length === 0, errors.join(' | ') || 'clean');
} finally {
  if (client) await client.close();
  chrome.kill();
  site.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
