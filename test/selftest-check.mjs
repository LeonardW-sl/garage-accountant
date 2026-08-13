/**
 * Verifies selftest.html itself.
 *
 * selftest.html is what the user will run on the vivo X30, and its whole value
 * is that a green verdict means the app works on that phone. A harness that
 * reports green regardless is worse than no harness — it would retire the one
 * real-device check we have while hiding the failure.
 *
 * So this runs it twice in real Blink over HTTP (same-origin, like GitHub
 * Pages): once against the real app, once against a deliberately broken copy.
 * Green then broken-goes-red is the property that makes the phone run
 * trustworthy.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = 9337;
const VIEWPORT = { width: 360, height: 800, dpr: 3 };

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json',
  '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Serves the repo, but lets a test swap index.html for a broken variant.
let indexOverride = null;
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const name = path === '/' ? '/selftest.html' : path;
  // No caching: the negative controls swap index.html between runs, and a cached
  // copy would let a broken app appear to pass.
  const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' };
  if (name === '/index.html' && indexOverride !== null) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'], ...noStore });
    res.end(indexOverride);
    return;
  }
  const file = join(ROOT, name.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream', ...noStore,
  });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'garage-selftest-'));
const chrome = spawn('google-chrome', [
  '--headless=new',
  `--remote-debugging-port=${PORT + 1}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars',
], { stdio: 'ignore' });

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try { if ((await CDP.List({ port: PORT + 1 })).length) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome did not start');
}

/** Runs selftest.html to completion and returns its verdict + rows. */
async function runSelftest(client) {
  const { Page, Runtime } = client;
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await Runtime.evaluate({
      expression, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    }
    return result.value;
  };

  // The app registers a Service Worker that caches its own shell, which would
  // serve the previous run's index.html to the negative controls.
  await Page.navigate({ url: `http://127.0.0.1:${PORT}/selftest.html` });
  await Page.loadEventFired();
  await evaluate(`(async () => {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    return true;
  })()`);
  // Reload so the iframe fetches index.html with no worker in the way.
  await Page.navigate({ url: `http://127.0.0.1:${PORT}/selftest.html?t=${Date.now()}` });
  await Page.loadEventFired();
  await new Promise((r) => setTimeout(r, 1200));
  await evaluate('runAll()');

  // Wait for the verdict to settle rather than guessing a duration.
  let state = null;
  for (let i = 0; i < 120; i++) {
    state = await evaluate(`(() => {
      const v = document.getElementById('verdict');
      return {
        cls: v.className,
        big: document.getElementById('verdictBig').textContent,
        rows: results.map(r => ({ name: r.name, state: r.state, detail: r.detail })),
        running: document.getElementById('runBtn').disabled,
      };
    })()`);
    if (!state.running && state.cls) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return state;
}

let client;
try {
  await waitForChrome();
  client = await CDP({ port: PORT + 1 });
  const { Page, Runtime, Emulation } = client;
  await Promise.all([Page.enable(), Runtime.enable()]);
  await Emulation.setDeviceMetricsOverride({
    width: VIEWPORT.width, height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.dpr, mobile: true,
  });

  // ---- 1. against the real app: must come out green ----
  indexOverride = null;
  const good = await runSelftest(client);
  const fails = good.rows.filter((r) => r.state === 'fail');
  record('selftest completes on the real app', !good.running && !!good.cls, good.big);
  record('selftest reports pass for the real app', good.cls === 'pass',
    fails.length ? `unexpected failures: ${fails.map((f) => `${f.name} (${f.detail})`).join(' | ')}` : good.big);

  // The checks that matter on the phone must actually have run, not be absent.
  const must = [
    'app 本体能启动',
    '有中文朗读引擎',
    '收据能转成图片',
    '图片有表格框线（样式没丢）',
    '收据没泄露成本/利润',
    '能离线存账（localStorage）',
  ];
  const namesSeen = good.rows.map((r) => r.name);
  const missing = must.filter((m) => !namesSeen.includes(m));
  record('selftest actually runs the high-risk checks', missing.length === 0,
    missing.length ? `never ran: ${missing.join(', ')}` : `${good.rows.length} checks`);

  const canvasRow = good.rows.find((r) => r.name === '收据能转成图片');
  record('receipt image check produced real dimensions', /\d+x\d+/.test(canvasRow?.detail || ''),
    canvasRow?.detail || 'no detail');

  // ---- 2. negative control: break the app, the selftest must go red ----
  const realIndex = readFileSync(join(ROOT, 'index.html'), 'utf8');

  // 2a. Break the receipt export the way OriginOS plausibly would: the SVG
  // rasterizes, but carries no styles. Empty the CSS rather than renaming the
  // variable — renaming throws a ReferenceError and kills the whole app, which
  // would prove nothing about the rule-rows check.
  indexOverride = realIndex.replace(
    'var RECEIPT_EXPORT_CSS =',
    'var RECEIPT_EXPORT_CSS = "";\nvar __UNUSED_EXPORT_CSS =',
  );
  if (indexOverride === realIndex) throw new Error('could not break RECEIPT_EXPORT_CSS — test is vacuous');
  const brokenCss = await runSelftest(client);
  const cssRow = brokenCss.rows.find((r) => r.name === '图片有表格框线（样式没丢）');
  record('selftest catches a receipt with no CSS',
    brokenCss.cls === 'fail' && cssRow?.state === 'fail',
    `verdict=${brokenCss.big} rule-rows-check=${cssRow?.state ?? 'never ran'} (${cssRow?.detail || ''})`);

  // 2b. Break the receipt so it leaks profit to the customer.
  // Guard-clause injection leaves the original body intact but unreachable, so
  // this cannot introduce a syntax error of its own and fail for a fake reason.
  indexOverride = realIndex.replace(
    'function renderReceipt(record) {',
    'function renderReceipt(record) {\n' +
    '  if (true) {\n' +
    '    document.getElementById("receiptPage").innerHTML =' +
    ' "<div>应收 1280 元 成本 847.5 利润 432.5</div>";\n' +
    '    showView("receiptView");\n' +
    '    return;\n' +
    '  }',
  );
  if (indexOverride === realIndex) throw new Error('could not break renderReceipt — test is vacuous');
  const brokenLeak = await runSelftest(client);
  const leakRow = brokenLeak.rows.find((r) => r.name === '收据没泄露成本/利润');
  record('selftest catches a receipt leaking cost/profit',
    brokenLeak.cls === 'fail' && leakRow?.state === 'fail',
    `verdict=${brokenLeak.big} leak-check=${leakRow?.state} (${leakRow?.detail || ''})`);

  // 2c. Break the app entirely — the selftest must not hang or claim success.
  indexOverride = '<!DOCTYPE html><html><body>totally broken</body></html>';
  const brokenAll = await runSelftest(client);
  const bootRow = brokenAll.rows.find((r) => r.name === 'app 本体能启动');
  record('selftest fails loudly when the app does not boot',
    brokenAll.cls === 'fail' && !brokenAll.running && bootRow?.state === 'fail',
    `verdict=${brokenAll.big} boot-check=${bootRow?.state ?? 'never ran'}`);

  // ---- 3. the verdict must be readable at arm's length on a phone ----
  indexOverride = null;
  await runSelftest(client);
  const legible = await Runtime.evaluate({
    expression: `(() => {
      const big = document.getElementById('verdictBig');
      const cs = getComputedStyle(big);
      const r = big.getBoundingClientRect();
      const de = document.documentElement;
      return { fontSize: parseFloat(cs.fontSize), top: r.top,
               overflow: de.scrollWidth - de.clientWidth };
    })()`, returnByValue: true,
  }).then((r) => r.result.value);
  record('verdict is big and above the fold', legible.fontSize >= 32 && legible.top < 300,
    `${legible.fontSize}px at y=${Math.round(legible.top)}`);
  record('selftest page itself does not overflow 360px', legible.overflow <= 2,
    `${legible.overflow}px over`);

  const shot = await Page.captureScreenshot({ format: 'png' });
  writeFileSync(join(ROOT, 'selftest-real-chrome.png'), Buffer.from(shot.data, 'base64'));
  record('selftest screenshot captured', true, 'selftest-real-chrome.png');
} finally {
  if (client) await client.close().catch(() => {});
  chrome.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
