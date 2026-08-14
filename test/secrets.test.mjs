/**
 * Credential-leak tests for the backup paths.
 *
 * settings holds two secrets: webdavPass and syncToken. Both export paths used
 * to serialize `settings` wholesale, which put those secrets into a file in the
 * phone's Downloads folder and uploaded them to the WebDAV server in plaintext.
 * The restore path already refuses to import foreign credentials (see the
 * comment there), so only the outbound direction was wrong.
 *
 * The rule enforced here: a backup carries the ledger, never the keys to it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(HERE, '..', 'index.html');

const SECRETS = {
  webdavUrl: 'https://dav.example.com/garage/',
  webdavUser: 'mechanic',
  webdavPass: 'sup3r-secret-dav-pw',
  syncUrl: 'https://garage.20040114.xyz',
  syncToken: 'sup3r-secret-sync-token',
};

const RECORD = {
  id: '1786600000000_ab12',
  date: '2026-08-13',
  plate: '皖A12345',
  receiptNo: 'GX20260813-001',
  items: [{ part: '机油滤芯', cost: 35, shipping: 0, totalCost: 35, finalPrice: 81.78 }],
  totalCost: 35,
  totalIncome: 81.78,
  createdAt: '2026-08-13T09:15:00.000Z',
};

function boot({ fetchImpl = null } = {}) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', (e) => errors.push(String(e.message)));
  const blobs = [];

  const dom = new JSDOM(readFileSync(HTML, 'utf8'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://leonardw-sl.github.io/garage-accountant/',
    virtualConsole: vc,
    beforeParse(win) {
      win.addEventListener('error', (e) => errors.push(String(e.message)));
      win.localStorage.setItem('garage_records', JSON.stringify([RECORD]));
      win.localStorage.setItem('garage_settings', JSON.stringify(SECRETS));
      win.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
      win.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [] };
      // Capture what would have hit the filesystem.
      const RealBlob = win.Blob;
      win.Blob = class extends RealBlob {
        constructor(parts, opts) { super(parts, opts); blobs.push(String(parts.join(''))); }
      };
      win.URL.createObjectURL = () => 'blob:stub';
      win.URL.revokeObjectURL = () => {};
      if (fetchImpl) win.fetch = fetchImpl;
    },
  });
  return { win: dom.window, errors, blobs };
}

function assertNoSecrets(text, where) {
  assert.ok(text, `${where}: produced no payload at all`);
  assert.ok(
    !text.includes(SECRETS.webdavPass),
    `${where}: leaked the WebDAV password in plaintext`,
  );
  assert.ok(
    !text.includes(SECRETS.syncToken),
    `${where}: leaked the sync token in plaintext`,
  );
}

test('exportData writes the ledger without the credentials', () => {
  const { win, blobs, errors } = boot();
  win.exportData();
  assert.deepEqual(errors, [], 'export threw');
  const payload = blobs[blobs.length - 1];
  assertNoSecrets(payload, 'exportData');
  // Still has to be a usable backup.
  const parsed = JSON.parse(payload);
  assert.equal(parsed.records.length, 1, 'export must still carry the ledger');
  assert.equal(parsed.records[0].receiptNo, 'GX20260813-001');
});

test('the WebDAV upload body carries no credentials', async () => {
  const sent = [];
  const fetchImpl = (url, opts = {}) => {
    sent.push({ url: String(url), body: opts.body ? String(opts.body) : '' });
    return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve('') });
  };
  const { win, errors } = boot({ fetchImpl });
  await win.backupToWebdav();
  assert.deepEqual(errors, [], 'backup threw');
  const put = sent.find((r) => r.body);
  assertNoSecrets(put.body, 'backupToWebdav');
  assert.ok(JSON.parse(put.body).records.length === 1, 'upload must still carry the ledger');
});

test('a leaked backup file cannot be replayed to reach the ledger', () => {
  // The point of stripping: a backup that falls into someone else's hands must
  // not double as working credentials for the sync endpoint.
  const { win, blobs } = boot();
  win.exportData();
  const parsed = JSON.parse(blobs[blobs.length - 1]);
  const imported = parsed.settings || {};
  assert.ok(!imported.syncToken, 'backup must not hand over a usable sync token');
  assert.ok(!imported.webdavPass, 'backup must not hand over a usable WebDAV password');
});

test('exporting does not disturb the live credentials', () => {
  const { win } = boot();
  win.exportData();
  assert.equal(win.settings.syncToken, SECRETS.syncToken, 'export must not clear the live token');
  assert.equal(win.settings.webdavPass, SECRETS.webdavPass, 'export must not clear the live password');
  assert.ok(win.syncConfig(), 'sync must still be configured after an export');
  const stored = JSON.parse(win.localStorage.getItem('garage_settings'));
  assert.equal(stored.syncToken, SECRETS.syncToken, 'stored token must survive an export');
});
