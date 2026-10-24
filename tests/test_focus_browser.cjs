// Run with Playwright installed: node tests/test_focus_browser.cjs
// Uses fake video plus simulated lens controls; never contacts the live ERP.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

async function main() {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) throw new Error('Outside site');
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(await fs.readFile(file));
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    for (const lensSupported of [true, false]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 },
        isMobile: true, hasTouch: true, permissions: ['camera'], serviceWorkers: 'block' });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript(({ lensSupported }) => {
        window.focusCalls = [];
        window.cameraRequests = [];
        const trackState = new WeakMap();
        const proto = MediaStreamTrack.prototype;
        const capabilities = proto.getCapabilities;
        const settings = proto.getSettings;
        const apply = proto.applyConstraints;
        const supported = navigator.mediaDevices.getSupportedConstraints.bind(navigator.mediaDevices);
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = constraints => {
          window.cameraRequests.push(constraints);
          return getUserMedia(constraints);
        };
        navigator.mediaDevices.getSupportedConstraints = () => ({ ...supported(),
          focusMode: lensSupported, pointsOfInterest: lensSupported });
        proto.getCapabilities = function () { return { ...capabilities.call(this),
          focusMode: lensSupported ? ['continuous', 'single-shot'] : [], torch: true }; };
        proto.getSettings = function () { return { ...settings.call(this), ...trackState.get(this) }; };
        proto.applyConstraints = async function (constraints) {
          window.focusCalls.push(JSON.parse(JSON.stringify(constraints)));
          const clean = { ...constraints };
          delete clean.focusMode;
          clean.advanced = (clean.advanced || []).map(entry => {
            const value = { ...entry };
            delete value.focusMode; delete value.pointsOfInterest; delete value.torch;
            return value;
          }).filter(entry => Object.keys(entry).length);
          await apply.call(this, clean);
          const controls = Object.assign({}, ...constraints.advanced);
          trackState.set(this, { ...trackState.get(this), ...controls });
        };
      }, { lensSupported });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let releaseDecoder;
      const decoderGate = new Promise(resolve => { releaseDecoder = resolve; });
      await page.route('**/js/zxing-worker.js*', async route => { await decoderGate; await route.continue(); });
      await page.goto(origin);
      await page.waitForFunction(() => typeof state !== 'undefined' && state.els && !state.els.scanBtn.disabled);
      assert.equal(await page.evaluate(() => state.isCameraRunning), false);
      await page.locator('#scanBtn').click();
      await page.waitForFunction(() => state.isCameraRunning && state.els.cameraPreview.videoWidth > 0);
      assert.equal(await page.evaluate(() => window.cameraRequests[0].video.focusMode?.ideal === 'continuous'), lensSupported);
      if (lensSupported) {
        await page.waitForFunction(() => window.focusCalls.some(call => call.advanced?.some(x => x.focusMode === 'continuous')));
        assert.equal(await page.evaluate(() => state.isScanning), false, 'focus starts before decoder readiness');
      }
      const box = await page.locator('#cameraPreview').boundingBox();
      const tap = { x: box.x + box.width * .25, y: box.y + box.height * .4 };
      await page.touchscreen.tap(tap.x, tap.y);
      await page.waitForFunction(() => document.getElementById('focusHint').textContent !== 'Focusing…');
      assert.equal(await page.locator('#focusTarget').isVisible(), true);
      if (lensSupported) {
        assert.equal(await page.locator('#focusHint').innerText(), 'Focus requested');
        const point = await page.evaluate(({ x, y }) => getPreviewFocusPoint(x, y), tap);
        const actual = await page.evaluate(() => state.track.getSettings().pointsOfInterest[0]);
        assert.ok(Math.abs(point.x - actual.x) < .002);
        assert.ok(Math.abs(point.y - actual.y) < .002);
        await page.waitForFunction(() => state.track.getSettings().focusMode === 'continuous');
        // Multiple taps inside the old 700ms cooldown still select the last point.
        await page.touchscreen.tap(box.x + box.width * .35, box.y + box.height * .55);
        await page.touchscreen.tap(box.x + box.width * .65, box.y + box.height * .6);
        await page.waitForFunction(() => state.track.getSettings().pointsOfInterest[0].y > .59);
      } else {
        assert.match(await page.locator('#focusHint').innerText(), /Point focus unavailable/);
      }
      releaseDecoder();
      await page.waitForFunction(() => state.isScanning);
      assert.equal(await page.evaluate(() => state.track.getSettings().width), 1920);
      assert.equal(await page.evaluate(() => state.track.getSettings().height), 1080);
      // Successful capture keeps the stream, and a new capture resets the point.
      await page.evaluate(() => { window.keptTrack = state.track; closeCapturePage({ captured: true }); });
      assert.equal(await page.evaluate(() => state.isCameraRunning), true);
      await page.locator('#scanBtn').click();
      await page.waitForFunction(() => state.isScanning);
      assert.equal(await page.evaluate(() => state.track === window.keptTrack && window.cameraRequests.length === 1), true);
      assert.equal(await page.locator('#focusHint').innerText(), 'Tap preview to focus');
      if (lensSupported) {
        await page.waitForFunction(() => state.track.getSettings().pointsOfInterest[0].x === .5 &&
          state.track.getSettings().pointsOfInterest[0].y === .5);
      }
      await page.locator('#captureBackBtn').click();
      assert.equal(await page.evaluate(() => state.isCameraRunning), false);
      assert.equal(await page.locator('#capturePage').isVisible(), false);
      assert.equal(await page.locator('#focusTarget').isVisible(), false);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS: mobile preview, decoder-independent focus, taps, fallback, 1080p, cancellation (lens controls ${lensSupported ? 'supported' : 'unsupported'})`);
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
