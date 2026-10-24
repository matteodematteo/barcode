// Deterministic camera-control regressions; no hardware or packages required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function setup(modes = ['continuous', 'single-shot'], supportsPoint = true) {
  const timers = new Map();
  let timerId = 0;
  const calls = [];
  const settings = { width: 1920, height: 1080, frameRate: 30, focusMode: 'manual', torch: true };
  const track = {
    readyState: 'live',
    getCapabilities: () => ({ focusMode: modes }),
    getSettings: () => ({ ...settings }),
    getConstraints: () => ({ width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, advanced: [{ torch: true }] }),
    async applyConstraints(constraints) {
      calls.push(constraints);
      if (track.hold) await track.hold;
      const values = Object.assign({}, ...constraints.advanced);
      if (track.rejectPoint && values.pointsOfInterest) throw new Error('Unsupported focus point');
      Object.assign(settings, values);
    },
  };
  const state = { track, scanSession: 1, capturePageOpen: true, isCameraRunning: true,
    focusRefreshTimers: [], els: { focusHint: { textContent: '' }, focusTarget: { hidden: true } } };
  const context = vm.createContext({ state, console, URL, document: { hidden: false },
    navigator: { mediaDevices: { getSupportedConstraints: () => ({ pointsOfInterest: supportsPoint }) } },
    window: { setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
      clearTimeout(id) { timers.delete(id); } } });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/camera.js'), 'utf8'), context);
  const run = (code) => vm.runInContext(code, context);
  const focus = (options) => { context.options = options; return run('requestFocusRefresh(state.track, options)'); };
  return { state, track, settings, calls, timers, run, focus };
}

async function main() {
  let t = setup();
  assert.equal(await t.focus({ newScan: true }), true);
  assert.equal(t.settings.focusMode, 'continuous');
  assert.equal(t.settings.pointsOfInterest[0].x, .5);
  const startupCalls = t.calls.length;
  await t.focus({ newScan: true });
  assert.equal(t.calls.length, startupCalls, 'healthy autofocus should not restart on every capture');
  assert.equal(await t.focus({ manual: true, point: { x: .2, y: .8 } }), true);
  assert.equal(t.settings.focusMode, 'continuous');
  assert.equal(t.settings.pointsOfInterest[0].x, .2);
  assert.equal(t.state.els.focusHint.textContent, 'Focus requested');
  assert.equal(await t.focus({ force: true, point: { x: .9, y: .9 } }), false);
  for (const call of t.calls) {
    assert.equal(call.width.ideal, 1920);
    assert.equal(call.height.ideal, 1080);
    assert.equal(call.frameRate.ideal, 30);
    assert.equal(Object.assign({}, ...call.advanced).torch, true);
  }
  assert.equal([...t.timers.values()].some(x => x.delay === 1200), false, 'no delayed lens-mode switch');
  for (const timer of [...t.timers.values()]) await timer.fn();
  assert.equal(await t.focus({ force: true, point: { x: .9, y: .9 } }), false);
  assert.equal(t.settings.focusMode, 'continuous');
  assert.equal(t.settings.pointsOfInterest[0].x, .2);

  // Slow startup plus two quick taps: the final tap wins, with no cooldown loss.
  t = setup();
  let release;
  t.track.hold = new Promise(resolve => { release = resolve; });
  const startup = t.focus({ newScan: true });
  await new Promise(setImmediate);
  const first = t.focus({ manual: true, point: { x: .1, y: .1 } });
  const last = t.focus({ manual: true, point: { x: .8, y: .7 } });
  release();
  await Promise.all([startup, first, last]);
  assert.equal(t.settings.pointsOfInterest[0].x, .8);
  assert.equal(t.calls.length, 2);

  // Closing while startup is applying constraints discards a waiting tap.
  t = setup();
  t.track.hold = new Promise(resolve => { release = resolve; });
  const opening = t.focus({ newScan: true });
  await new Promise(setImmediate);
  const waitingTap = t.focus({ manual: true, point: { x: .7, y: .7 } });
  t.run('clearFocusRefreshTimers()');
  t.state.capturePageOpen = false;
  t.state.scanSession++;
  release();
  await Promise.all([opening, waitingTap]);
  assert.equal(t.calls.length, 1);
  assert.equal([...t.timers.values()].some(x => x.delay === 1200), false);

  // A stopped capture cannot run a queued focus; reopening resets the target.
  t = setup();
  await t.focus({ manual: true, point: { x: .3, y: .3 } });
  t.run('clearFocusRefreshTimers()');
  await t.focus({ newScan: true });
  assert.equal(t.settings.pointsOfInterest[0].x, .5);
  t.state.capturePageOpen = false;
  t.state.scanSession++;
  const count = t.calls.length;
  for (const timer of [...t.timers.values()]) await timer.fn();
  assert.equal(t.calls.length, count);
  assert.equal(await t.focus({ manual: true }), false);

  // Browser support does not guarantee that the particular lens accepts points.
  t = setup();
  t.track.rejectPoint = true;
  assert.equal(await t.focus({ manual: true, point: { x: .4, y: .6 } }), true);
  assert.match(t.state.els.focusHint.textContent, /point focus unavailable/);
  assert.equal(t.calls.length, 2);

  // Single-shot-only lenses remain available, with no forced mode restoration.
  t = setup(['single-shot']);
  assert.equal(await t.focus({ manual: true, point: { x: .2, y: .3 } }), true);
  assert.equal(t.settings.focusMode, 'single-shot');
  assert.equal([...t.timers.values()].some(x => x.delay === 1200), false);

  // Automatic barcode assistance must leave hardware zoom unchanged.
  t = setup();
  t.state.isScanning = true;
  t.settings.zoom = 1;
  t.track.getCapabilities = () => ({ focusMode: ['continuous'], zoom: { min: 1, max: 4, step: .1 } });
  t.run('assistSmallBarcode({ x: 30, y: 30, width: 20, height: 10 }, { sx: 0, sy: 0, sw: 1920, sh: 1080, outputWidth: 1920, outputHeight: 1080, videoWidth: 1920, videoHeight: 1080 }, 1)');
  t.run('assistSmallBarcode({ x: 30, y: 30, width: 20, height: 10 }, { sx: 0, sy: 0, sw: 1920, sh: 1080, outputWidth: 1920, outputHeight: 1080, videoWidth: 1920, videoHeight: 1080 }, 1)');
  await new Promise(setImmediate);
  assert.equal(t.settings.zoom, 1);
  assert.ok(t.calls.length > 0, 'barcode assistance still requests focus');
  assert.ok(t.calls.every(call => call.advanced.every(entry => entry.zoom === undefined)));
  t = setup([], false);
  assert.equal(await t.focus({ manual: true, point: { x: .4, y: .6 } }), false);
  assert.equal(t.calls.length, 0);
  t = setup(['continuous'], false);
  assert.equal(await t.focus({ manual: true, point: { x: .4, y: .6 } }), true);
  assert.equal(t.settings.focusMode, 'continuous');
  assert.match(t.state.els.focusHint.textContent, /point focus unavailable/);

  // Point mapping accounts for the cropped sides of a landscape camera on a phone.
  t = setup();
  t.state.els.cameraPreview = { videoWidth: 1920, videoHeight: 1080,
    getBoundingClientRect: () => ({ left: 10, top: 20, right: 310, bottom: 620, width: 300, height: 600 }) };
  let point = t.run('getPreviewFocusPoint(160, 320)');
  assert.equal(point.x, .5);
  assert.equal(point.y, .5);
  point = t.run('getPreviewFocusPoint(10, 20)');
  assert.equal(point.x, (1920 - 540) / 2 / 1920);
  assert.equal(point.y, 0);
  assert.equal(t.run('getPreviewFocusPoint(5, 20)'), null);
  console.log('PASS: immediate continuous focus, no mode timer or automatic zoom, persistent tap priority, rapid taps, cancellation, fallback, preserved quality/torch, cropped coordinates');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
