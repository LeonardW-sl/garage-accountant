/**
 * Real-browser verification for index.html.
 *
 * jsdom cannot render canvas or SVG foreignObject, so the receipt-image path
 * was never truly tested — the jsdom suite only asserted that no CDN URL
 * appears in the source. This drives real Blink over CDP instead, at the
 * viewport size of the target phone, and checks the things jsdom can't:
 * layout overflow, tap-target size, and whether the PNG actually encodes.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = 9333;
// vivo X30: 1080x2400 at DPR 3 → 360x800 CSS pixels.
const VIEWPORT = { width: 360, height: 800, dpr: 3 };

const profile = mkdtempSync(join(tmpdir(), 'garage-chrome-'));
const downloads = mkdtempSync(join(tmpdir(), 'garage-dl-'));

const chrome = spawn('google-chrome', [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--autoplay-policy=no-user-gesture-required',
], { stdio: 'ignore' });

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await CDP.List({ port: PORT });
      if (list.length) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome did not start');
}

let client;
try {
  await waitForChrome();
  client = await CDP({ port: PORT });
  const { Page, Runtime, Emulation, Browser, Console } = client;
  await Promise.all([Page.enable(), Runtime.enable(), Console.enable()]);
  await Emulation.setDeviceMetricsOverride({
    width: VIEWPORT.width, height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.dpr, mobile: true,
  });

  // Capture anything the page logs or throws.
  const pageErrors = [];
  Runtime.exceptionThrown(({ exceptionDetails }) => {
    pageErrors.push(exceptionDetails.exception?.description || exceptionDetails.text);
  });
  Console.messageAdded(({ message }) => {
    if (message.level === 'error') pageErrors.push(`console: ${message.text}`);
  });

  await Browser.setDownloadBehavior({
    behavior: 'allow', downloadPath: downloads, eventsEnabled: true,
  }).catch(() => {});

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await Runtime.evaluate({
      expression, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    }
    return result.value;
  };

  await Page.navigate({ url: `file://${join(ROOT, 'index.html')}` });
  await Page.loadEventFired();
  await new Promise((r) => setTimeout(r, 1500)); // let init()'s spoken greeting fire

  // ---- 1. loads clean in real Blink ----
  record('loads with no uncaught errors in real Chrome', pageErrors.length === 0,
    pageErrors.join(' | '));

  // ---- 2. the start button is reachable and big enough to hit ----
  const startBtn = await evaluate(`(() => {
    const b = document.querySelector('.big-start-btn');
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), visible: r.height > 0 };
  })()`);
  record('start button is a large tap target',
    startBtn.visible && startBtn.h >= 48 && startBtn.w >= 200,
    `${startBtn.w}x${startBtn.h}px`);

  // ---- 3. nothing overflows horizontally at 360px ----
  const overflow = await evaluate(`(() => {
    const bad = [];
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > ${VIEWPORT.width} + 1) {
        bad.push(el.tagName + (el.id ? '#' + el.id : '') + ' right=' + Math.round(r.right));
      }
    });
    return bad.slice(0, 6);
  })()`);
  record('no horizontal overflow at 360px', overflow.length === 0, overflow.join(', '));

  // ---- 3b. button labels must not wrap ----
  // A wrapped label ("历史账" / "目") is hard to recognize by shape, which is how
  // he reads buttons — he matches the whole label, he does not read it.
  const wrapped = await evaluate(`(() => {
    const bad = [];
    document.querySelectorAll('button').forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.height === 0) return;
      const cs = getComputedStyle(b);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      if (Math.round((r.height - pad) / lh) > 1 && b.textContent.trim().length < 12) {
        bad.push(b.textContent.trim().slice(0, 14) + ' (' + Math.round(r.width) + 'px)');
      }
    });
    return bad;
  })()`);
  record('button labels fit on one line', wrapped.length === 0, wrapped.join(', '));

  // ---- 3c. every tap target is at least 48px ----
  const smallTargets = await evaluate(`(() => {
    const small = [];
    document.querySelectorAll('button').forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.height > 0 && (r.height < 48 || r.width < 48)) {
        small.push(b.textContent.trim().slice(0, 8) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
    });
    return small;
  })()`);
  record('all tap targets are at least 48px', smallTargets.length === 0, smallTargets.join(', '));

  // ---- 3d. a toast must not cover the numbers ----
  // Digits are the only thing he can read, so occluding them is a real defect.
  const toastOverlap = await evaluate(`(() => {
    toast('测试提示信息');
    const t = document.getElementById('toast').getBoundingClientRect();
    const hit = [];
    ['todayCount', 'todayIncome', 'todayProfit'].forEach((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      if (!(t.right < r.left || t.left > r.right || t.bottom < r.top || t.top > r.bottom)) hit.push(id);
    });
    return hit;
  })()`);
  record('toast does not cover the today figures', toastOverlap.length === 0,
    toastOverlap.join(', '));

  // ---- 4. drive the whole flow the way the father would ----
  await evaluate(`startFlow()`);
  await evaluate(`document.getElementById('guideInput').value = '皖 A12345。'; confirmPlate();`);
  const plate = await evaluate(`flow.plate`);
  record('plate normalized in real browser', plate === '皖A12345', `got "${plate}"`);

  await evaluate(`document.getElementById('guideInput').value = '三元催化器 800'; confirmPart();`);
  const pending = await evaluate(`JSON.stringify(flow.pendingItem)`);
  record('part with a numeral in its name parsed correctly',
    pending === JSON.stringify({ part: '三元催化器', cost: 800, shipping: 0 }), pending);

  await evaluate(`acceptPart(); goToPrice();`);
  await evaluate(`document.getElementById('guideInput').value = '一千二'; confirmPrice(); acceptPrice();`);

  const rec = await evaluate(`(() => {
    const r = JSON.parse(localStorage.getItem('garage_records'))[0];
    return { income: r.totalIncome, cost: r.totalCost, no: r.receiptNo, date: r.date,
             lineSum: r.items.reduce((a, b) => a + b.finalPrice, 0) };
  })()`);
  record('ledger totals correct', rec.income === 1200 && rec.cost === 800 && rec.lineSum === 1200,
    JSON.stringify(rec));

  // ---- 5. the receipt as the customer sees it ----
  const receipt = await evaluate(`document.getElementById('receiptPage').innerText`);
  const leaks = ['成本', '利润', '运费', '800'].filter((k) => receipt.includes(k));
  record('receipt leaks no cost or profit to the customer', leaks.length === 0,
    leaks.length ? `leaked: ${leaks.join(',')}` : '');
  record('receipt shows the amount charged', receipt.includes('1200'));
  record('receipt shows the amount in Chinese words', receipt.includes('壹仟贰佰元整'),
    (receipt.match(/[壹贰叁肆伍陆柒捌玖拾佰仟万元整角分]{4,}/) || ['none'])[0]);

  // ---- 6. THE POINT: does saveReceiptImage actually produce a PNG? ----
  // Rendered in real Blink with a real canvas, which jsdom cannot do at all.
  const png = await evaluate(`(async () => {
    const page = document.getElementById('receiptPage');
    const width = page.offsetWidth || 360;
    const height = page.scrollHeight || 640;
    const clone = page.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    clone.style.width = width + 'px';
    clone.style.background = '#fff';
    clone.style.color = '#000';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
      '<foreignObject width="100%" height="100%">' +
      new XMLSerializer().serializeToString(clone) + '</foreignObject></svg>';
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = width * 2; c.height = height * 2;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
          const data = c.toDataURL('image/png');
          // A blank render still encodes, so sample the middle for dark pixels.
          const px = ctx.getImageData(0, 0, c.width, c.height).data;
          let dark = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] < 128 && px[i+1] < 128 && px[i+2] < 128) dark++;
          }
          resolve({ ok: true, bytes: data.length, dark, w: c.width, h: c.height });
        } catch (e) {
          resolve({ ok: false, error: e.name + ': ' + e.message });
        }
      };
      img.onerror = () => resolve({ ok: false, error: 'image failed to load' });
      img.src = url;
    });
  })()`);
  record('SVG foreignObject renders to canvas in real Blink', png.ok === true,
    png.ok ? `${png.w}x${png.h}, ${Math.round(png.bytes / 1024)}KB` : png.error);
  record('rendered receipt is not blank (canvas not tainted)',
    png.ok === true && png.dark > 500, png.ok ? `${png.dark} dark pixels` : 'n/a');

  // ---- 6b. the image must LOOK like the receipt, not just contain its text ----
  // "Not blank" was too weak a proxy: the first version of this passed while
  // producing an unstyled wall of text with no table borders and a huge blank
  // tail. Assert on the rendered appearance via the app's own code path.
  const fidelity = await evaluate(`(async () => {
    const shot = await window.__renderReceiptCanvas();
    if (!shot.ok) return shot;
    const c = shot.canvas;
    const ctx = c.getContext('2d');
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const rowInk = [];
    for (let y = 0; y < c.height; y++) {
      let ink = 0;
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (px[i] < 200 && px[i+1] < 200 && px[i+2] < 200) ink++;
      }
      rowInk.push(ink);
    }
    const inked = rowInk.filter((n) => n > 0).length;
    const lastInk = rowInk.reduce((acc, n, i) => (n > 0 ? i : acc), 0);
    // Table borders are long horizontal runs of dark pixels; unstyled text has none.
    const ruleRows = rowInk.filter((n) => n > c.width * 0.5).length;
    return {
      ok: true, w: c.width, h: c.height,
      inkRatio: +(inked / c.height).toFixed(3),
      tailBlankRatio: +(1 - lastInk / c.height).toFixed(3),
      ruleRows,
    };
  })()`);

  record('receipt image keeps its table rules (CSS embedded)',
    fidelity.ok === true && fidelity.ruleRows >= 3,
    fidelity.ok ? `${fidelity.ruleRows} full-width rule rows` : fidelity.error);
  record('receipt image has no large blank tail',
    fidelity.ok === true && fidelity.tailBlankRatio < 0.15,
    fidelity.ok ? `${Math.round(fidelity.tailBlankRatio * 100)}% blank at bottom` : fidelity.error);

  // ---- 7. the actual button, including the download ----
  await evaluate(`saveReceiptImage()`);
  await new Promise((r) => setTimeout(r, 2500));
  const files = existsSync(downloads)
    ? readFileSync ? (await import('node:fs')).readdirSync(downloads) : [] : [];
  const pngFile = files.find((f) => f.endsWith('.png'));
  let pngValid = false;
  if (pngFile) {
    const buf = readFileSync(join(downloads, pngFile));
    // PNG magic number.
    pngValid = buf.length > 1000 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
  }
  record('save-image button writes a valid PNG file', pngValid,
    pngFile ? `${pngFile} (${Math.round((readFileSync(join(downloads, pngFile)).length) / 1024)}KB)`
            : `no png; files: ${files.join(',') || 'none'}`);

  // ---- 8. history view, and the receipt screenshot for eyeballing ----
  await evaluate(`showView('historyView')`);
  const hist = await evaluate(`document.getElementById('historyList').innerText`);
  record('history lists the job', hist.includes('皖A12345'), hist.replace(/\n/g, ' / ').slice(0, 80));

  await evaluate(`showView('receiptView')`);
  const shot = await Page.captureScreenshot({ format: 'png', captureBeyondViewport: true });
  writeFileSync(join(ROOT, 'receipt-real-chrome.png'), Buffer.from(shot.data, 'base64'));
  record('receipt screenshot captured', true, 'receipt-real-chrome.png');

  await evaluate(`showView('homeView')`);
  const home = await Page.captureScreenshot({ format: 'png' });
  writeFileSync(join(ROOT, 'home-real-chrome.png'), Buffer.from(home.data, 'base64'));
  record('home screenshot captured', true, 'home-real-chrome.png');

  record('still no uncaught errors after the full flow', pageErrors.length === 0,
    pageErrors.join(' | '));
} finally {
  if (client) await client.close().catch(() => {});
  chrome.kill();
  // Chrome keeps writing to its profile for a moment after SIGTERM, so a plain
  // rmSync races it and throws ENOTEMPTY.
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
