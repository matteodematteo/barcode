// Browser regressions for capture quantities, saved lists, and the product editor.
// Fake camera and local lookup/send stubs only; no live ERP or printer requests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' };

async function main() {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) throw new Error('Outside site');
      const content = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(content);
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 },
      isMobile: true, hasTouch: true, permissions: ['camera'], serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => typeof state !== 'undefined' && state.els && !state.els.scanBtn.disabled);
    await page.evaluate(() => {
      window.lookupCalls = [];
      loadOptionalDiscount = async () => null;
      loadProductInfoResponse = async (code, onCookie) => {
        window.lookupCalls.push(code);
        onCookie?.('test-cookie');
        if (window.holdNextLookup) {
          window.holdNextLookup = false;
          await new Promise(resolve => { window.releaseLookup = resolve; });
        }
        const product = { id: 'p-' + code, goods_code: code, italian_name: 'Product ' + code,
          p_price: '4.00', s_price: '10.00', real_inventory: '12' };
        return { raw: product, normalized: product, cookie: 'test-cookie' };
      };
    });
    assert.equal(await page.locator('main #quantityInput').count(), 0);
    assert.equal(await page.locator('main #quantityPad').count(), 0);
    assert.equal(await page.locator('#productInfoSection').isVisible(), true);
    const captureBox = await page.locator('#scanBtn').boundingBox();
    const modeBox = await page.locator('#entryModeBtn').boundingBox();
    assert.ok(captureBox.y + captureBox.height < modeBox.y);
    assert.ok(modeBox.x > 300 && modeBox.y > 740);
    await page.locator('#entryModeBtn').click();
    assert.equal(await page.evaluate(() => state.isQuantityEntryUnlocked), true);
    assert.equal(await page.locator('#productInfoSection').isVisible(), true);
    assert.equal(await page.locator('#quantityPadCard').isVisible(), false);
    const screenshotDir = path.join(os.tmpdir(), 'webscanner-flow-qa');
    await fs.mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, 'main.png'), fullPage: true });

    const scan = async code => {
      await page.locator('#scanBtn').click();
      await page.waitForFunction(() => state.isScanning);
      await page.evaluate(code => { handleDetectedCode(code); }, code);
    };
    await scan('4006381333931');
    assert.equal(await page.locator('#quantityPadCard').isVisible(), true);
    assert.equal(await page.locator('#capturePage').isVisible(), true);
    assert.equal(await page.evaluate(() => state.isScanning), false);
    assert.equal(await page.evaluate(() => state.track.readyState), 'live');
    assert.equal(await page.evaluate(() => window.lookupCalls.length), 0);
    assert.equal(await page.evaluate(() => state.history.length), 0);
    assert.equal(await page.evaluate(() => document.querySelector('main').inert && state.els.capturePage.inert), true);
    await page.screenshot({ path: path.join(screenshotDir, 'quantity-camera.png') });
    for (const viewport of [{ width: 280, height: 653 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const box = await page.locator('.quantity-capture-card').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1);
      assert.ok(box.y >= 0 && box.y + box.height <= viewport.height + 1);
      const enter = await page.locator('#quantityPad [data-key="enter"]').boundingBox();
      assert.ok(enter.y + enter.height <= viewport.height, 'quantity Enter remains visible in landscape');
      await page.screenshot({ path: path.join(screenshotDir, `quantity-${viewport.width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#quantityPad [data-key="2"]').click();
    await page.locator('#quantityPad [data-key="5"]').click();
    assert.equal(await page.locator('#quantityInput').inputValue(), '25');
    await page.evaluate(() => { window.holdNextLookup = true; });
    await page.locator('#quantityPad [data-key="enter"]').click();
    await page.waitForFunction(() => typeof window.releaseLookup === 'function');
    assert.equal(await page.locator('#capturePage').isVisible(), false);
    assert.equal(await page.locator('#quantityPadCard').isVisible(), false);
    assert.equal(await page.evaluate(() => state.history[0].comparison_qty), 25);
    assert.equal(await page.evaluate(() => state.history.length), 1);

    // A second quantity can be chosen while the earlier network request is pending.
    await scan('5901234123457');
    await page.locator('#quantityPad [data-key="3"]').click();
    await page.evaluate(() => { window.releaseLookup(); });
    await page.waitForFunction(() => state.currentProductRecord !== null);
    assert.equal(await page.locator('#quantityPadCard').isVisible(), true);
    assert.equal(await page.locator('#quantityInput').inputValue(), '3');
    assert.equal(await page.evaluate(() => state.pendingQuantityCode), '5901234123457');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.history.length === 2 && state.currentProductRecord?.barcode === '5901234123457');
    assert.equal(await page.locator('#productInfoSection').isVisible(), true);
    assert.equal(await page.evaluate(() => state.history[0].comparison_qty), 3);
    await scan('9780201379624');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#capturePage').isVisible(), false);
    assert.equal(await page.locator('#quantityPadCard').isVisible(), false);
    assert.equal(await page.evaluate(() => state.history.length), 2);
    assert.equal(await page.evaluate(() => state.isCameraRunning), false);
    assert.equal(await page.evaluate(() => document.querySelector('main').inert), false);
    await scan('9780201379624');
    await page.goBack();
    assert.equal(await page.locator('#quantityPadCard').isVisible(), false);
    assert.equal(await page.evaluate(() => state.history.length), 2);
    assert.equal(await page.evaluate(() => state.isCameraRunning), false);

    // Typed barcodes use the same popup; an empty quantity is not submitted.
    await page.locator('#barcodeInput').fill('1234567890123');
    await page.locator('#barcodeInput').press('Enter');
    await page.locator('#quantityPad [data-key="clear"]').click();
    await page.keyboard.press('Enter');
    assert.match(await page.locator('#quantityStatus').innerText(), /at least 1/);
    await page.keyboard.press('4');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.history.length === 3);
    assert.equal(await page.evaluate(() => state.history[0].comparison_qty), 4);
    await page.locator('#entryModeBtn').click();
    assert.equal(await page.locator('#productInfoSection').isVisible(), true);
    await scan('3210987654321');
    await page.waitForFunction(() => !state.capturePageOpen && state.history.length === 4);
    assert.equal(await page.locator('#quantityPadCard').isVisible(), false);
    assert.equal(await page.evaluate(() => state.history[0].comparison_qty), 1);

    // Cancellation saves nothing; confirmation persists a full snapshot before clearing.
    await page.locator('#clearAllBtn').click();
    await page.locator('#confirmDialogCancelBtn').click();
    assert.equal(await page.evaluate(() => state.history.length), 4);
    assert.equal(await page.evaluate(() => state.printRequests.length), 0);
    await page.locator('#clearAllBtn').click();
    await page.locator('#confirmDialogOkBtn').click();
    assert.equal(await page.evaluate(() => state.history.length), 0);
    assert.equal(await page.evaluate(() => state.printRequests[0].type), 'LIST');
    assert.equal(await page.evaluate(() => state.printRequests[0].items.length), 4);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(CONFIG.printRequestStorageKey))[0].items.length), 4);
    await page.locator('#printBtn').click();
    await page.locator('.print-request-row').first().click();
    assert.equal(await page.locator('#printRequestDetailTitle').innerText(), 'Saved list');
    assert.equal(await page.locator('.print-request-item').count(), 4);
    await page.screenshot({ path: path.join(screenshotDir, 'saved-list.png') });
    await page.locator('#printRequestCancelBtn').click();
    await page.locator('#printBackBtn').click();
    await page.reload();
    await page.waitForFunction(() => state.els && !state.els.scanBtn.disabled);
    assert.equal(await page.evaluate(() => state.printRequests[0].type), 'LIST');
    assert.equal(await page.evaluate(() => state.printRequests[0].items.length), 4);
    assert.equal(await page.locator('#printBtn').isEnabled(), true);
    assert.equal(await page.evaluate(() => state.printRequests[0].items.some(item => item.p_price === '4.00')), true);
    // Archived rows can be reprinted without relying on the cleared active list.
    await page.evaluate(() => {
      apiFetch = async (url, options) => {
        window.savedPrintPayload = JSON.parse(options.body);
        return new Response('{}', { status: 200 });
      };
      openPrintRequestDetail(state.printRequests[0].id);
    });
    await page.locator('#printRequestTxtBtn').click();
    await page.waitForFunction(() => window.savedPrintPayload && !state.isPrintRequestSending);
    assert.equal(await page.evaluate(() => window.savedPrintPayload.data[0].items.length), 4);
    assert.equal(await page.evaluate(() => state.printRequests[0].type), 'TXT');
    await page.locator('#printBackBtn').click();
    const savedRequestCount = await page.evaluate(() => state.printRequests.length);

    // Storage errors must leave the source list intact.
    await page.evaluate(() => {
      addHistoryItem('1111111111111', 2);
      window.originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === CONFIG.printRequestStorageKey) throw new Error('Quota exceeded');
        return window.originalSetItem.call(this, key, value);
      };
      clearAllHistory();
      Storage.prototype.setItem = window.originalSetItem;
    });
    assert.equal(await page.evaluate(() => state.history.length), 1);
    assert.equal(await page.evaluate(() => state.printRequests.length), savedRequestCount);

    // Editing follows the visible order, skips the barcode, and supports price edits.
    await page.evaluate(() => {
      const item = normalizeHistoryItem({ id: 'edit-test', goods_id: 'p1', barcode: '1111111111111',
        italian_name: 'Example', p_price: '4.00', s_price: '10.00', s_discount: '20',
        discount_price: '8.00', comparison_qty: 2 });
      state.history = [item]; saveHistoryState(); renderHistory();
      state.editingHistoryId = item.id; openHistoryEditDialog(item);
    });
    const order = ['historyEditPPriceInput', 'historyEditItalianNameInput', 'historyEditSPriceInput',
      'historyEditSDiscountInput', 'historyEditDiscountPriceInput', 'historyEditQtyInput', 'historyEditSaveBtn'];
    for (const id of order) {
      assert.equal(await page.evaluate(() => document.activeElement.id), id);
      if (id !== 'historyEditSaveBtn') await page.keyboard.press('Enter');
    }
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'historyEditBackBtn');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), order[0]);
    for (const id of [...order.slice(1, -1), 'historyEditSaveBtn', 'historyEditBackBtn']) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), id);
    }
    assert.equal(await page.locator('#historyEditBarcodeInput').getAttribute('readonly'), '');
    await page.locator('#historyEditDiscountPriceInput').fill('7.50');
    assert.equal(await page.locator('#historyEditSDiscountInput').inputValue(), '25');
    await page.locator('#historyEditSDiscountInput').fill('20');
    assert.equal(Number(await page.locator('#historyEditDiscountPriceInput').inputValue()), 8);
    await page.locator('#historyEditQtyInput').fill('4');
    await page.screenshot({ path: path.join(screenshotDir, 'editor.png') });
    await page.locator('#historyEditSaveBtn').click();
    await page.waitForFunction(() => !state.els.historyEditDialog.classList.contains('is-open'));
    assert.equal(await page.evaluate(() => state.history[0].comparison_qty), 4);
    // A late background refresh must not overwrite text already being edited.
    await page.evaluate(() => {
      loadProductAndDiscountResponse = () => new Promise(resolve => { window.finishEditorRefresh = resolve; });
      openHistoryEditor(0).catch(error => { window.editorError = error.message; });
    });
    await page.waitForFunction(() => typeof window.finishEditorRefresh === 'function');
    await page.locator('#historyEditPPriceInput').fill('5.50');
    await page.locator('#historyEditItalianNameInput').fill('My edited name');
    await page.evaluate(() => window.finishEditorRefresh({ product: { id: 'p1', goods_code: '1111111111111',
      italian_name: 'Remote name', p_price: '7.00', s_price: '10.00' }, discountPrice: '8.00', hasDiscount: true, saleDiscount: 20 }));
    await page.waitForFunction(() => state.els.historyEditSaveNote.textContent.includes('Your edits were kept'));
    assert.equal(await page.locator('#historyEditPPriceInput').inputValue(), '5.50');
    assert.equal(await page.locator('#historyEditItalianNameInput').inputValue(), 'My edited name');
    await page.locator('#historyEditBackBtn').click();
    assert.deepEqual(errors, []);
    console.log('PASS: quantity popup over camera, immediate return, overlapping lookups, typed/classic capture, cancellation, floating controls, preserved product info');
    console.log('PASS: confirmed-clear snapshots, cancellation/storage-failure protection, persistence, saved-list viewing and stubbed reprinting');
    console.log('PASS: editor field order, Enter/Tab focus, read-only barcode, discount-price synchronization, quantity saving and late-refresh edit protection');
    console.log(`Screenshots: ${screenshotDir}`);
    await context.close();
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
