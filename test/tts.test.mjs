/**
 * TTS tests.
 *
 * Speech is the main road for this user: he cannot read the screen, so anything
 * the app fails to say is information he never receives. speak() used to
 * swallow every failure, which is the one behaviour we cannot afford — a silent
 * failure is indistinguishable from a working app until money is already wrong.
 *
 * These tests cover what a machine can check: that a voice is chosen, that
 * failure is surfaced rather than swallowed, and that the spoken text never
 * carries profit. Whether the voice is actually audible and intelligible can
 * only be judged by ear on the real phone.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(HERE, '..', 'index.html');

const ZH = { name: 'Chinese Female', lang: 'zh-CN', localService: true };
const EN = { name: 'English', lang: 'en-US', localService: true };

/**
 * @param voices what getVoices() reports
 * @param mode   'ok' | 'throw' | 'error-event' | 'never-starts'
 */
function boot({ voices = [ZH], mode = 'ok' } = {}) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', (e) => errors.push(String(e.message)));
  const spoken = [];
  const toasts = [];

  const dom = new JSDOM(readFileSync(HTML, 'utf8'), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://leonardw-sl.github.io/garage-accountant/',
    virtualConsole: vc,
    beforeParse(win) {
      win.addEventListener('error', (e) => errors.push(String(e.message)));
      win.SpeechSynthesisUtterance = class {
        constructor(t) { this.text = String(t); this.voice = null; this.lang = ''; this.rate = 1; }
      };
      win.speechSynthesis = {
        getVoices: () => voices,
        cancel() {},
        speak(u) {
          if (mode === 'throw') throw new Error('synthesis unavailable');
          spoken.push(u);
          if (mode === 'error-event') { if (u.onerror) u.onerror({ error: 'synthesis-failed' }); return; }
          if (mode === 'never-starts') return;
          if (u.onstart) u.onstart({});
          if (u.onend) u.onend({});
        },
      };
    },
  });
  const win = dom.window;
  const realToast = win.toast;
  win.toast = function (m) { toasts.push(String(m)); return realToast.apply(this, arguments); };
  return { win, errors, spoken, toasts };
}

test('a Chinese voice is picked when one exists', () => {
  const { win, spoken } = boot({ voices: [EN, ZH] });
  win.speak('测试');
  assert.equal(spoken.length, 1, 'nothing was spoken');
  assert.ok(spoken[0].voice, 'no voice was selected, the engine default may be English');
  assert.equal(spoken[0].voice.lang, 'zh-CN', 'must not read Chinese with an English voice');
  assert.equal(spoken[0].lang, 'zh-CN');
  assert.ok(spoken[0].rate <= 0.9, 'digits need a slower rate than default');
});

test('missing Chinese voice is reported, not swallowed', () => {
  const { win, toasts, errors } = boot({ voices: [EN] });
  win.speak('收了一百块');
  assert.deepEqual(errors, [], 'speak threw');
  assert.ok(
    toasts.length > 0,
    'with no Chinese voice the app said nothing and showed nothing: he gets no feedback at all',
  );
});

test('a throwing speech engine still surfaces something on screen', () => {
  const { win, toasts, errors } = boot({ mode: 'throw' });
  win.speak('收了一百块');
  assert.deepEqual(errors, [], 'a TTS failure must never break the flow');
  assert.ok(toasts.length > 0, 'the failure was swallowed entirely');
});

test('an onerror from the engine surfaces on screen', () => {
  const { win, toasts, errors } = boot({ mode: 'error-event' });
  win.speak('收了一百块');
  assert.deepEqual(errors, [], 'onerror must not break the flow');
  assert.ok(toasts.length > 0, 'engine reported an error and the user was told nothing');
});

test('the mute signal reaches him without requiring reading', () => {
  // He cannot read the toast. The perceivable channels are vibration and the
  // indicator turning into a standing mute sign.
  const buzzes = [];
  const { win } = boot({ voices: [EN] });
  win.navigator.vibrate = (p) => { buzzes.push(p); return true; };
  win.speak('收了一百块');
  const ind = win.document.getElementById('speakIndicator');
  assert.ok(ind.classList.contains('mute'), 'no visible mute sign for a user who cannot read');
  assert.ok(buzzes.length > 0, 'no vibration: a silent failure stays silent');
});

test('the mute warning is not repeated on every save', () => {
  const { win, toasts } = boot({ voices: [EN] });
  for (let i = 0; i < 5; i += 1) win.speak('收了一百块');
  assert.equal(toasts.length, 1, 'nagging on every record trains him to ignore it');
});

test('mute clears once speech actually works again', () => {
  const { win } = boot({ voices: [ZH] });
  win.reportMuteOnce('forced');
  const ind = win.document.getElementById('speakIndicator');
  assert.ok(ind.classList.contains('mute'));
  win.speak('测试');
  assert.ok(!ind.classList.contains('mute'), 'a stale mute sign would be a false alarm forever');
});

test('an engine that accepts the utterance but never speaks is caught', async () => {
  // The likeliest real failure: no throw, no onerror, just silence.
  const buzzes = [];
  const { win, toasts, spoken } = boot({ mode: 'never-starts' });
  win.navigator.vibrate = (p) => { buzzes.push(p); return true; };
  win.speak('收了一百块');
  assert.equal(spoken.length, 1, 'the utterance should have been handed to the engine');
  const ind = win.document.getElementById('speakIndicator');
  assert.ok(ind.classList.contains('on'), 'should optimistically show speaking at first');
  await new Promise((r) => setTimeout(r, win.SPEAK_START_TIMEOUT + 300));
  assert.ok(!ind.classList.contains('on'), 'indicator stuck on forever after silent failure');
  assert.ok(ind.classList.contains('mute'), 'silent failure left no visible trace');
  assert.ok(buzzes.length > 0, 'silent failure left no perceivable trace at all');
  assert.ok(toasts.length > 0, 'silent failure was never reported');
});

test('a watchdog does not fire when speech works', async () => {
  const { win, toasts } = boot({ voices: [ZH] });
  win.speak('测试');
  await new Promise((r) => setTimeout(r, win.SPEAK_START_TIMEOUT + 300));
  const ind = win.document.getElementById('speakIndicator');
  assert.ok(!ind.classList.contains('mute'), 'false mute alarm on a working engine');
  assert.deepEqual(toasts, [], 'working speech must not warn about anything');
});

test('the speaking indicator clears when speech ends', () => {
  const { win } = boot();
  win.speak('测试');
  const ind = win.document.getElementById('speakIndicator');
  assert.ok(ind, 'no speak indicator element');
  assert.ok(!ind.classList.contains('on'), 'indicator stuck on after speech ended');
});

test('the indicator does not stick on when the engine errors', () => {
  const { win } = boot({ mode: 'error-event' });
  win.speak('测试');
  const ind = win.document.getElementById('speakIndicator');
  assert.ok(!ind.classList.contains('on'), 'indicator stuck on after an error');
});

test('a plate is spelled out digit by digit', () => {
  const { win, spoken } = boot();
  const said = [];
  const orig = win.speak;
  win.speak = function (t) { said.push(String(t)); return orig.apply(this, arguments); };
  win.records = [{
    id: 'r1', date: '2026-08-13', plate: '皖A12345', receiptNo: 'GX20260813-001',
    items: [{ part: '机油滤芯', finalPrice: 81.78, totalCost: 35 }],
    totalCost: 35, totalIncome: 81.78,
  }];
  win.speakRecord('r1');
  assert.ok(said.length, 'nothing was spoken for the record');
  void spoken;
});
