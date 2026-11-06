"use strict";
const decoderStartupStarted = performance.now();

// Keep the wrapper and WASM binary pinned to the same release, served locally.
importScripts("vendor/zxing-wasm/3.1.5/reader.js");
importScripts("capture-frame-worker.js?v=189");
const ready = ZXingWASM.prepareZXingModule({
  overrides: {
    locateFile: (path) => new URL("vendor/zxing-wasm/3.1.5/" + path, self.location.href).href
  },
  fireImmediately: true
});
ready.then(() => self.postMessage({ type: "ready", initializeMs: performance.now() - decoderStartupStarted,
  videoFrames: typeof VideoFrame === "function" && typeof OffscreenCanvas === "function" }))
  .catch((error) => self.postMessage({ type: "error", error: error.message }));

let frameDiagnostics = null;
// WASM calls cannot be interrupted, but our own image processing can. Check
// once per small block/row group so a difficult shelf cannot turn a 60ms
// attempt into hundreds of milliseconds before the next camera frame.
const decodeBudgetExhausted = {};
let decodeDeadline = Infinity;
function checkDecodeBudget() {
  if (performance.now() >= decodeDeadline) throw decodeBudgetExhausted;
}
async function readDiagnosticBarcodes(pixels, options) {
  checkDecodeBudget();
  const diagnostics = frameDiagnostics;
  if (!diagnostics) return ZXingWASM.readBarcodes(pixels, options);
  const started = performance.now();
  let results;
  try { results = await ZXingWASM.readBarcodes(pixels, options); return results; }
  finally {
    const durationMs = performance.now() - started;
    diagnostics.wasmCalls++;
    diagnostics.wasmMs += durationMs;
    diagnostics.maxWasmReadMs = Math.max(diagnostics.maxWasmReadMs, durationMs);
    const accepted = (results || []).filter(isAcceptedBarcode);
    diagnostics.rejectedResults += (results?.length || 0) - accepted.length;
    if (diagnostics.reads.length < 8) diagnostics.reads.push({ stage: diagnostics.stage, durationMs,
      width: pixels.width, height: pixels.height, tryHarder: options.tryHarder,
      downscale: options.tryDownscale, binarizer: options.binarizer, minLineCount: options.minLineCount,
      accepted: accepted.length, rejected: (results?.length || 0) - accepted.length });
  }
}

function invertPixels(pixels) {
  for (let i = 0; i < pixels.data.length; i += 4) {
    if ((i & 16383) === 0) checkDecodeBudget();
    pixels.data[i] = 255 - pixels.data[i];
    pixels.data[i + 1] = 255 - pixels.data[i + 1];
    pixels.data[i + 2] = 255 - pixels.data[i + 2];
  }
}

// Local lighting correction for faint bars and shadows. This only runs after
// the original image fails. Integral sums keep it linear in the pixel count.
// A small dead band leaves flat areas and minor sensor noise as background.
let luminance = new Uint8Array(0);
let integral = new Uint32Array(0);
function prepareContrast(pixels) {
  checkDecodeBudget();
  const { width, height, data } = pixels;
  const count = width * height;
  const stride = width + 1;
  const sumSize = stride * (height + 1);
  if (luminance.length < count) luminance = new Uint8Array(count);
  // Camera crops are capped at 1920px per side, so their sums fit in 32 bits.
  if (integral.length < sumSize) integral = new Uint32Array(sumSize);
  integral.fill(0, 0, stride);
  let darkest = 255, lightest = 0;
  for (let y = 0; y < height; y++) {
    if ((y & 7) === 0) checkDecodeBudget();
    let rowSum = 0;
    integral[(y + 1) * stride] = 0;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      const value = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      luminance[p] = value;
      if (value < darkest) darkest = value;
      if (value > lightest) lightest = value;
      rowSum += value;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
    }
  }
  // Neither enhancement polarity can produce a bar within the 3-level dead band.
  return lightest - darkest > 3;
}

function enhanceContrast(pixels, inverted = false) {
  checkDecodeBudget();
  const { width, height } = pixels;
  const stride = width + 1;
  const radius = 24;
  const output = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    if ((y & 7) === 0) checkDecodeBudget();
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width, x + radius + 1);
      const sum = integral[bottom * stride + right] - integral[top * stride + right]
        - integral[bottom * stride + left] + integral[top * stride + left];
      const average = sum / ((right - left) * (bottom - top));
      const delta = luminance[y * width + x] - average;
      const value = (inverted ? delta > 3 : delta < -3) ? 0 : 255;
      const i = (y * width + x) * 4;
      output.data[i] = output.data[i + 1] = output.data[i + 2] = value;
      output.data[i + 3] = 255;
    }
  }
  return output;
}

// Estimate the barcode axis from image gradients. Work stays in the worker
// and is bounded by sampling; ordinary successful reads never pay this cost.
function estimateBarcodeRotation(pixels, rect = null) {
  const { data } = pixels;
  const width = rect?.width || pixels.width, height = rect?.height || pixels.height;
  const left = rect?.x || 0, top = rect?.y || 0;
  const step = Math.max(2, Math.floor(Math.max(width, height) / 480));
  let xx = 0, yy = 0, xy = 0;
  for (let y = step; y < height - step; y += step) {
    checkDecodeBudget();
    for (let x = step; x < width - step; x += step) {
      const i = ((y + top) * pixels.width + x + left) * 4 + 1;
      const gx = data[i + 4] - data[i - 4];
      const gy = data[i + pixels.width * 4] - data[i - pixels.width * 4];
      xx += gx * gx;
      yy += gy * gy;
      xy += gx * gy;
    }
  }
  if (xx + yy === 0) return 0;
  let angle = -Math.atan2(2 * xy, xx - yy) * 90 / Math.PI;
  // Native horizontal/vertical scans already cover multiples of 90 degrees.
  if (angle > 45) angle -= 90;
  if (angle < -45) angle += 90;
  return Math.abs(angle) >= 5 ? angle : 0;
}

// Pure typed arrays also work on iOS versions without OffscreenCanvas.
function rotateBarcodePixels(pixels, angle, enlargement = 1) {
  checkDecodeBudget();
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const rotatedWidth = Math.abs(pixels.width * cos) + Math.abs(pixels.height * sin);
  const rotatedHeight = Math.abs(pixels.width * sin) + Math.abs(pixels.height * cos);
  const scale = Math.min(enlargement, 1920 / Math.max(rotatedWidth, rotatedHeight));
  const width = Math.ceil(rotatedWidth * scale), height = Math.ceil(rotatedHeight * scale);
  const output = new ImageData(width, height);
  const source = new Uint8Array(pixels.width * pixels.height);
  for (let i = 0; i < source.length; i++) {
    if ((i & 4095) === 0) checkDecodeBudget();
    const p = i * 4;
    source[i] = (pixels.data[p] * 77 + pixels.data[p + 1] * 150 + pixels.data[p + 2] * 29) >> 8;
  }
  const target = new Uint32Array(output.data.buffer);
  target.fill(0xffffffff);
  const dx = cos / scale, dy = -sin / scale;
  for (let y = 0; y < height; y++) {
    if ((y & 3) === 0) checkDecodeBudget();
    let sx = ((0.5 - width / 2) * cos + (y + 0.5 - height / 2) * sin) / scale + pixels.width / 2 - 0.5;
    let sy = (-(0.5 - width / 2) * sin + (y + 0.5 - height / 2) * cos) / scale + pixels.height / 2 - 0.5;
    for (let x = 0; x < width; x++, sx += dx, sy += dy) {
      if (sx >= 0 && sy >= 0 && sx < pixels.width - 1 && sy < pixels.height - 1) {
        const left = Math.floor(sx), top = Math.floor(sy);
        const fx = sx - left, fy = sy - top;
        const p = top * pixels.width + left;
        const upper = source[p] + (source[p + 1] - source[p]) * fx;
        const lower = source[p + pixels.width] + (source[p + pixels.width + 1] - source[p + pixels.width]) * fx;
        const value = Math.round(upper + (lower - upper) * fy);
        target[y * width + x] = 0xff000000 | value * 0x010101;
      }
    }
  }
  return output;
}

const MATRIX_FORMATS = new Set(["Aztec", "DataMatrix", "MaxiCode", "PDF417", "QRCode", "MicroQRCode", "rMQRCode"]);
function isAcceptedBarcode(result) {
  if (!result?.isValid) return false;
  // Only linear retail/product labels are configured, but reject matrix
  // symbologies defensively if a decoder build or future caller adds them.
  if (MATRIX_FORMATS.has(result.format)) return false;
  // ZXing's ITF14 format filter can still return generic ITF fragments.
  // Retail ITF-14 needs all 14 digits and its GS1 check digit.
  if (/^ITF/.test(result.format)) {
    if (!/^\d{14}$/.test(result.text)) return false;
    let checksum = 0;
    for (let i = 0; i < 14; i++) checksum += Number(result.text[i]) * (i % 2 ? 1 : 3);
    return checksum % 10 === 0;
  }
  return true;
}

// Separate strongly coloured, locally uniform label surfaces from shelves,
// foil reflections and printed packaging. White labels use the strip search.
function findColourLabelRegions(pixels) {
  checkDecodeBudget();
  const { width, height, data } = pixels, tile = 16;
  const cols = Math.ceil(width / tile), rows = Math.ceil(height / tile);
  const hues = new Int8Array(cols * rows); hues.fill(-1);
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    if (tx === 0) checkDecodeBudget();
    let r = 0, g = 0, b = 0, count = 0;
    for (let dy = 3; dy < tile; dy += 5) for (let dx = 3; dx < tile; dx += 5) {
      const x = tx * tile + dx, y = ty * tile + dy;
      if (x >= width || y >= height) continue;
      const i = (y * width + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
    }
    r /= count; g /= count; b /= count;
    const high = Math.max(r, g, b), low = Math.min(r, g, b), chroma = high - low;
    if (high < 45 || chroma < 35 || chroma / high < 0.45) continue;
    let hue = high === r ? (g - b) / chroma : high === g ? 2 + (b - r) / chroma : 4 + (r - g) / chroma;
    hue = (hue + 6) % 6;
    hues[ty * cols + tx] = Math.floor(hue * 2);
  }
  const regions = [];
  for (let start = 0; start < hues.length; start++) {
    if ((start & 63) === 0) checkDecodeBudget();
    if (hues[start] < 0) continue;
    const hue = hues[start], queue = [start]; hues[start] = -1;
    let left = cols, right = 0, top = rows, bottom = 0;
    for (let next = 0; next < queue.length; next++) {
      if ((next & 63) === 0) checkDecodeBudget();
      const index = queue[next], x = index % cols, y = Math.floor(index / cols);
      left = Math.min(left, x); right = Math.max(right, x + 1);
      top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const i = ny * cols + nx, neighbour = hues[i];
        const distance = Math.abs(neighbour - hue);
        if (neighbour >= 0 && (distance <= 1 || distance >= 11)) { hues[i] = -1; queue.push(i); }
      }
    }
    const x = left * tile, y = top * tile, w = Math.min(width, right * tile) - x, h = Math.min(height, bottom * tile) - y;
    if (queue.length < 12 || w < 96 || h < 32 || w * h > width * height * 0.5 || queue.length / ((right - left) * (bottom - top)) < 0.5) continue;
    const dx = (x + w / 2 - width / 2) / width, dy = (y + h / 2 - height / 2) / height;
    regions.push({ x, y, width: w, height: h, score: 1 / (1 + 12 * (dx * dx + dy * dy)) });
  }
  regions.sort((a, b) => b.score - a.score);
  return regions.slice(0, 6);
}

// Scan native-resolution rows for dense alternating edges. Tiny/short bars
// are located independently of brighter packaging text or shelf outlines.
function findBarcodeStrips(pixels) {
  checkDecodeBudget();
  const { width, height, data } = pixels;
  const step = 4, groups = [];
  for (let y = 2; y < height - 2; y += step) {
    checkDecodeBudget();
    const row = y * width * 4;
    let peaks = [], previousSign = 0, strongest = 0, peakX = 0, lastX = -100;
    const commitGroup = () => {
      if (peaks.length < 24) { peaks = []; return; }
      const x0 = peaks[0], x1 = peaks[peaks.length - 1], span = x1 - x0;
      if (span < 48 || span > width * 0.92) { peaks = []; return; }
      let group = null;
      for (let i = groups.length - 1; i >= 0; i--) {
        if ((i & 127) === 0) checkDecodeBudget();
        const g = groups[i];
        if (y - g.bottom > 12) continue;
        const overlap = Math.min(x1, g.right) - Math.max(x0, g.left);
        if (overlap > Math.min(span, g.right - g.left) * 0.75 &&
            Math.abs(span - (g.right - g.left)) < span * 0.3) { group = g; break; }
      }
      if (!group) { group = { left: x0, right: x1, top: y, bottom: y, rows: 0, edges: 0 }; groups.push(group); }
      group.left = Math.min(group.left, x0); group.right = Math.max(group.right, x1);
      group.bottom = y; group.rows++; group.edges = Math.max(group.edges, peaks.length);
      peaks = [];
    };
    const commitPeak = () => {
      if (!previousSign) return;
      if (peakX - lastX > 24) commitGroup();
      peaks.push(peakX); lastX = peakX;
    };
    for (let x = 2; x < width - 2; x++) {
      if ((x & 255) === 0) checkDecodeBudget();
      // Green preserves chromatic bar contrast on yellow/red shelf labels.
      const gradient = data[row + (x + 1) * 4 + 1] - data[row + (x - 1) * 4 + 1];
      const sign = gradient >= 3 ? 1 : gradient <= -3 ? -1 : 0;
      if (sign && sign === previousSign) {
        if (Math.abs(gradient) > strongest) { strongest = Math.abs(gradient); peakX = x; }
      } else {
        commitPeak(); previousSign = sign; strongest = Math.abs(gradient); peakX = x;
      }
    }
    commitPeak(); commitGroup();
  }
  const regions = [];
  for (const g of groups) {
    checkDecodeBudget();
    if (g.rows < 3 || g.bottom - g.top < 8) continue;
    const span = g.right - g.left, barHeight = g.bottom - g.top;
    if (barHeight > span * 1.2) continue;
    const px = Math.max(16, span * 0.15), py = Math.max(24, Math.min(48, barHeight * 0.75));
    const x = Math.max(0, Math.floor(g.left - px)), y = Math.max(0, Math.floor(g.top - py));
    const w = Math.min(width, Math.ceil(g.right + px)) - x;
    const h = Math.min(height, Math.ceil(g.bottom + py)) - y;
    regions.push({ x, y, width: w, height: h, barPattern: true,
      core: { x: g.left - x, y: g.top - y, width: span, height: barHeight },
      score: Math.min(g.edges, 90) * Math.min(g.rows, 16) / Math.sqrt(span) /
        (1 + 8 * (((g.left + g.right) / 2 / width - 0.5) ** 2 +
          ((g.top + g.bottom) / 2 / height - 0.5) ** 2)), edges: g.edges });
  }
  regions.sort((a, b) => b.score - a.score);
  return regions.slice(0, 8);
}

function measureBarcodeFocus(pixels, strips) {
  const strip = strips.find(({ edges, core }) => edges >= 35 && edges <= 160 &&
    core.height >= 12 && core.height / core.width >= 0.055 && core.width < pixels.width * 0.8);
  if (!strip) return null;
  const { width, height } = strip.core;
  const x = strip.x + strip.core.x, y = strip.y + strip.core.y;
  let variation = 0, curvature = 0;
  // Wide, blurry transitions change gradually. Normalize edge curvature by
  // local contrast so a dim but sharply printed barcode can stay in focus.
  for (const fraction of [0.25, 0.5, 0.75]) {
    const row = ((y + Math.round(height * fraction)) * pixels.width + x) * 4 + 1;
    for (let i = row + 4; i < row + (width - 1) * 4; i += 4) {
      const before = pixels.data[i] - pixels.data[i - 4];
      const after = pixels.data[i + 4] - pixels.data[i];
      if (Math.abs(before) + Math.abs(after) < 5) continue;
      variation += Math.abs(before) + Math.abs(after);
      curvature += Math.abs(after - before);
    }
  }
  return variation > width * 2 ? { x, y, width, height, sharpness: curvature / variation } : null;
}

// Normalize a colour channel using the bars' own intensity range, rather than
// a bright shelf/reflection elsewhere in the camera frame.
function normalizeBarcodePixels(pixels, channel = 1, core = null) {
  checkDecodeBudget();
  const { width, height, data } = pixels, hist = new Uint32Array(256);
  const x0 = Math.max(0, Math.floor(core?.x || 0)), y0 = Math.max(0, Math.floor(core?.y || 0));
  const x1 = Math.min(width, Math.ceil(x0 + (core?.width || width)));
  const y1 = Math.min(height, Math.ceil(y0 + (core?.height || height)));
  let count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (x === x0 && (y & 7) === 0) checkDecodeBudget();
    hist[data[(y * width + x) * 4 + channel]]++; count++;
  }
  let low = 0, high = 255, sum = 0;
  for (; low < 255; low++) { sum += hist[low]; if (sum >= count * 0.02) break; }
  sum = 0;
  for (; high > low; high--) { sum += hist[high]; if (sum >= count * 0.02) break; }
  if (high - low < 6) return null;
  const output = new ImageData(width, height), gain = 255 / (high - low);
  const gray = Uint32Array.from(hist, (_, intensity) => {
    const value = Math.max(0, Math.min(255, Math.round((intensity - low) * gain)));
    return 0xff000000 | value * 0x010101;
  });
  const target = new Uint32Array(output.data.buffer);
  for (let p = 0; p < target.length; p++) {
    if ((p & 4095) === 0) checkDecodeBudget();
    target[p] = gray[data[p * 4 + channel]];
  }
  return output;
}

async function readContrastEan13(pixels, options, deadline, expectedText = "") {
  const readOptions = { ...options, formats: ["EAN13"], minLineCount: 4, tryInvert: false };
  for (const channel of [1, 0]) {
    if (performance.now() >= deadline) break;
    const normalized = normalizeBarcodePixels(pixels, channel);
    if (!normalized || performance.now() >= deadline) continue;
    for (const binarizer of ["LocalAverage", "FixedThreshold"]) {
      if (performance.now() >= deadline) break;
      const results = await readDiagnosticBarcodes(normalized, { ...readOptions, binarizer });
      const matches = results.filter(result => isAcceptedBarcode(result) &&
        (!expectedText || result.text === expectedText));
      if (matches.length) return matches;
    }
  }
  return [];
}

// Locate concentrated parallel edges before resizing/rotating an entire frame.
// Every frame is located independently so changes in distance cannot leave a
// stale crop. All pixel processing stays in this worker (including on iOS).
// Regular packaging stripes have constant black/white run widths. Real
// linear codes contain varied module widths across several adjacent rows.
// This ranks candidates only; the decoder still decides what is a barcode.
function hasBarcodeRunPattern(pixels, rect) {
  // Only sampled lines/gradients are needed. Copying all pixels for each of
  // twelve candidates was more expensive than decoding the actual barcode.
  const angle = -estimateBarcodeRotation(pixels, rect) * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const half = Math.min(rect.width / Math.max(0.001, Math.abs(cos)),
    rect.height / Math.max(0.001, Math.abs(sin))) / 2 - 1;
  let matchingRows = 0;
  for (const offset of [-0.06, 0, 0.06]) {
    checkDecodeBudget();
    const shift = Math.min(rect.width, rect.height) * offset;
    const cx = rect.width / 2 - sin * shift, cy = rect.height / 2 + cos * shift;
    const values = [];
    let darkest = 255, lightest = 0;
    for (let d = -half; d <= half; d++) {
      const x = Math.round(cx + cos * d), y = Math.round(cy + sin * d);
      if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) continue;
      const i = ((y + rect.y) * pixels.width + x + rect.x) * 4;
      const value = (pixels.data[i] * 77 + pixels.data[i + 1] * 150 + pixels.data[i + 2] * 29) >> 8;
      values.push(value); darkest = Math.min(darkest, value); lightest = Math.max(lightest, value);
    }
    if (lightest - darkest < 12) continue;
    const threshold = (lightest + darkest) / 2, runs = [[], []];
    let previous = values[0] < threshold ? 0 : 1, count = 0, first = true;
    for (const value of values) {
      const color = value < threshold ? 0 : 1;
      if (color !== previous) {
        if (!first) runs[previous].push(count);
        first = false; previous = color; count = 0;
      }
      count++;
    }
    if (runs.some((widths) => widths.length < 8)) continue;
    const varied = runs.every((widths) => {
      const mean = widths.reduce((sum, width) => sum + width, 0) / widths.length;
      const variance = widths.reduce((sum, width) => sum + (width - mean) ** 2, 0) / widths.length;
      return variance / (mean * mean) >= 0.035;
    });
    if (varied) matchingRows++;
  }
  return matchingRows >= 2;
}

function findBarcodeRegions(pixels, regionOffset = 0) {
  checkDecodeBudget();
  const { width, height, data } = pixels;
  const tile = 32, cols = Math.ceil(width / tile), rows = Math.ceil(height / tile);
  const active = new Uint8Array(cols * rows), scores = new Float32Array(active.length);
  let darkest = 255, lightest = 0;
  const luma = (i) => (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  for (let ty = 0; ty < rows; ty++) {
    checkDecodeBudget();
    for (let tx = 0; tx < cols; tx++) {
      let xx = 0, yy = 0, xy = 0, magnitude = 0, count = 0;
      for (let y = Math.max(1, ty * tile); y < Math.min(height - 1, (ty + 1) * tile); y += 4) {
        for (let x = Math.max(1, tx * tile); x < Math.min(width - 1, (tx + 1) * tile); x += 4) {
          const i = (y * width + x) * 4, value = luma(i);
          darkest = Math.min(darkest, value); lightest = Math.max(lightest, value);
          const gx = luma(i + 4) - luma(i - 4);
          const gy = luma(i + width * 4) - luma(i - width * 4);
          xx += gx * gx; yy += gy * gy; xy += gx * gy;
          magnitude += Math.abs(gx) + Math.abs(gy); count++;
        }
      }
      const energy = xx + yy;
      const coherence = energy ? Math.hypot(xx - yy, 2 * xy) / energy : 0;
      const index = ty * cols + tx;
      if (count && magnitude / count >= 8 && coherence >= 0.35) {
        active[index] = 1; scores[index] = energy;
      }
    }
  }
  const regions = [];
  for (let start = 0; start < active.length; start++) {
    if ((start & 31) === 0) checkDecodeBudget();
    if (!active[start]) continue;
    const queue = [start]; active[start] = 0;
    let left = cols, right = 0, top = rows, bottom = 0, score = 0;
    for (let next = 0; next < queue.length; next++) {
      if ((next & 31) === 0) checkDecodeBudget();
      const index = queue[next], x = index % cols, y = Math.floor(index / cols);
      left = Math.min(left, x); right = Math.max(right, x + 1);
      top = Math.min(top, y); bottom = Math.max(bottom, y + 1); score += scores[index];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const neighbor = ny * cols + nx;
        if (active[neighbor]) { active[neighbor] = 0; queue.push(neighbor); }
      }
    }
    if (queue.length < 2) continue;
    const padding = Math.max(24, Math.ceil(Math.max(right - left, bottom - top) * tile * 0.12));
    const x = Math.max(0, left * tile - padding), y = Math.max(0, top * tile - padding);
    const w = Math.min(width, right * tile + padding) - x;
    const h = Math.min(height, bottom * tile + padding) - y;
    if (w * h >= width * height * 0.8) continue;
    regions.push({ x, y, width: w, height: h, score: score / Math.sqrt(w * h) });
  }
  regions.sort((a, b) => b.score - a.score);
  // Consider more than the strongest four edge clusters, so bright stripes
  // and text cannot push a faint/small barcode out of the search entirely.
  const candidates = regions.slice(0, 12);
  // Pattern ranking is a hint, not a prerequisite for a read. Leave time for
  // actual decoding and rotate the inspected candidates on subsequent frames.
  const rankingDeadline = Math.min(decodeDeadline - 8, performance.now() + 8);
  const offset = candidates.length ? Math.abs(regionOffset) % candidates.length : 0;
  for (let i = 0; i < candidates.length && performance.now() < rankingDeadline; i++) {
    const rect = candidates[(offset + i) % candidates.length];
    rect.barPattern = hasBarcodeRunPattern(pixels, rect);
  }
  const plausible = candidates.filter((rect) => rect.barPattern);
  const remaining = candidates.filter((rect) => !rect.barPattern);
  const remainingOffset = remaining.length ? Math.abs(regionOffset) % remaining.length : 0;
  const ordered = plausible.concat(remaining.map((_, i) => remaining[(remainingOffset + i) % remaining.length]));
  let hasContrast = lightest > darkest;
  if (!hasContrast) {
    // A coarse grid must never discard a thin label between sample points.
    const reference = luma(0);
    for (let i = 4; i < data.length; i += 4) {
      if ((i & 16383) === 0) checkDecodeBudget();
      if (luma(i) !== reference) { hasContrast = true; break; }
    }
  }
  return { regions: ordered.slice(0, 8), hasContrast };
}

function cropBarcodePixels(pixels, rect) {
  checkDecodeBudget();
  const output = new ImageData(rect.width, rect.height);
  for (let y = 0; y < rect.height; y++) {
    if ((y & 15) === 0) checkDecodeBudget();
    const start = ((rect.y + y) * pixels.width + rect.x) * 4;
    output.data.set(pixels.data.subarray(start, start + rect.width * 4), y * rect.width * 4);
  }
  return output;
}

async function readThinBars(pixels, options) {
  if (!options.formats?.includes("EAN13")) return [];
  // Thin dark bars can lose a pixel on each edge through glare, blur or print
  // loss. Widen them horizontally by one pixel without moving the scan rows.
  checkDecodeBudget();
  const { width, height, data } = pixels;
  const corrected = new ImageData(width, height);
  const target = new Uint32Array(corrected.data.buffer);
  for (let y = 0; y < height; y++) {
    if ((y & 7) === 0) checkDecodeBudget();
    const start = y * width;
    for (let x = 0; x < width; x++) {
      const p = start + x;
      const value = Math.min(data[p * 4 + 1], data[(x ? p - 1 : p) * 4 + 1],
        data[(x + 1 < width ? p + 1 : p) * 4 + 1]);
      target[p] = 0xff000000 | value * 0x010101;
    }
  }
  return readDiagnosticBarcodes(corrected, { ...options, formats: ["EAN13"], tryHarder: true,
    tryRotate: false, tryInvert: false, tryDownscale: false, minLineCount: Math.max(3, options.minLineCount) });
}

async function readBarcodeStrip(pixels, rect, options, deadline) {
  if (performance.now() >= deadline) return [];
  const crop = cropBarcodePixels(pixels, rect);
  if (performance.now() >= deadline) return [];
  // A checksum-valid retail code can be recovered from one clean scanline in
  // a small crop. The page still requires the same code on another live frame.
  // Use ZXing's fast path on native/normalized crops; reserve rotations and
  // inversion for the enlarged retry, where they are most useful.
  const candidateOptions = { ...options, tryHarder: false, tryDownscale: false, minLineCount: 1 };
  let results = await readDiagnosticBarcodes(crop, candidateOptions);
  if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
    const normalized = normalizeBarcodePixels(crop, 1, rect.core);
    if (normalized && performance.now() < deadline) results = await readDiagnosticBarcodes(normalized, candidateOptions);
  }
  if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
    const normalized = normalizeBarcodePixels(crop, 1);
    if (normalized && performance.now() < deadline) results = await readDiagnosticBarcodes(normalized, candidateOptions);
  }
  if (!results.some(isAcceptedBarcode) && rect.core && performance.now() < deadline) {
    // Small shelf labels often reach the sensor with only a few pixels per
    // bar. Normalize the candidate crop and enlarge it before giving up.
    const normalized = normalizeBarcodePixels(crop, 1, rect.core) || normalizeBarcodePixels(crop, 1);
    if (normalized && performance.now() < deadline) {
      const enlarged = rotateBarcodePixels(normalized, 0, 3);
      const scale = enlarged.width / normalized.width;
      if (scale > 1 && performance.now() < deadline) {
        results = await decodeBarcodePixels(enlarged, { ...candidateOptions, tryHarder: true, tryDownscale: false },
          { orientation: "auto", thorough: true, enhance: true }, deadline);
        if (results.some(isAcceptedBarcode)) {
          results = offsetBarcodePositions(
            restoreRotatedPositions(results, normalized, enlarged, 0, scale), rect);
          return results;
        }
      }
    }
  }
  return results.some(isAcceptedBarcode) ? offsetBarcodePositions(results, rect) : [];
}

const EAN13_L = ["0001101", "0011001", "0010011", "0111101", "0100011",
  "0110001", "0101111", "0111011", "0110111", "0001011"];
const EAN13_G = ["0100111", "0110011", "0011011", "0100001", "0011101",
  "0111001", "0000101", "0010001", "0001001", "0010111"];
const EAN13_R = EAN13_L.map((pattern) => [...pattern].map((bit) => bit === "0" ? "1" : "0").join(""));
const EAN13_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG",
  "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

function closestEanDigit(bits, patterns) {
  let bestDigit = -1, bestDistance = 8, tied = false;
  for (let digit = 0; digit < patterns.length; digit++) {
    let distance = 0;
    for (let i = 0; i < 7; i++) if (bits[i] !== patterns[digit][i]) distance++;
    if (distance < bestDistance) { bestDigit = digit; bestDistance = distance; tied = false; }
    else if (distance === bestDistance) tied = true;
  }
  return tied || bestDistance > 1 ? null : { digit: bestDigit, distance: bestDistance };
}

function decodeEan13Modules(bits, maxDistance = 3) {
  if (bits.length < 95 || bits.slice(0, 3).join("") !== "101" ||
      bits.slice(45, 50).join("") !== "01010" || bits.slice(92, 95).join("") !== "101") return null;
  const left = [], parity = [];
  let distance = 0;
  for (let i = 0; i < 6; i++) {
    const pattern = bits.slice(3 + i * 7, 10 + i * 7).join("");
    const l = closestEanDigit(pattern, EAN13_L), g = closestEanDigit(pattern, EAN13_G);
    if (!l && !g) return null;
    if (g && (!l || g.distance < l.distance)) { left.push(g.digit); parity.push("G"); distance += g.distance; }
    else { left.push(l.digit); parity.push("L"); distance += l.distance; }
  }
  const first = EAN13_PARITY.indexOf(parity.join(""));
  if (first < 0) return null;
  const right = [];
  for (let i = 0; i < 6; i++) {
    const decoded = closestEanDigit(bits.slice(50 + i * 7, 57 + i * 7).join(""), EAN13_R);
    if (!decoded) return null;
    right.push(decoded.digit); distance += decoded.distance;
  }
  const text = String(first) + left.join("") + right.join("");
  let checksum = 0;
  for (let i = 0; i < 12; i++) checksum += Number(text[i]) * (i % 2 ? 3 : 1);
  if ((10 - checksum % 10) % 10 !== Number(text[12]) || distance > maxDistance) return null;
  return { text, distance };
}

function restoreErasedEanBar(bits, start, width) {
  // The missing bar must be inside the space, leaving a space on each side.
  // Require exact digit patterns and reject every ambiguous reconstruction.
  let text = "";
  for (let offset = 1; offset < width - 1; offset++) {
    for (let size = 1; size <= 4 && offset + size < width; size++) {
      const left = start + offset, right = left + size;
      const candidate = bits.slice(0, left) + "1".repeat(size) + bits.slice(right);
      const decoded = decodeEan13Modules(candidate.split(""), 0);
      if (!decoded) continue;
      if (text && text !== decoded.text) return "";
      text = decoded.text;
    }
  }
  return text;
}

function readEanGuardRow(edges, deadline) {
  // A complete EAN-13 has 59 alternating runs. One erased bar joins
  // its two neighbours, reducing the count to 57. Use the three guards
  // as anchors so each half can have its own scale under perspective.
  for (let i = 1; i + 58 < edges.length; i += 2) {
    if (performance.now() >= deadline) return null;
    for (const runCount of [59, 57]) {
      const end = i + runCount;
      if (end + 1 >= edges.length) continue;
      const left = edges[i], right = edges[end];
      const pitch = (right - left) / 95;
      if (pitch < 1.5 || left - edges[i - 1] < 4 * pitch ||
          edges[end + 1] - right < 4 * pitch) continue;
      const repaired = runCount === 57;
      for (const middle of repaired ? [25, 27] : [27]) {
        const center = i + middle, rightStart = center + 5;
        const sections = [
          [i, center, 45], [center, rightStart, 5], [rightStart, end, 45]
        ];
        let bits = "", gapStart = -1, gapWidth = 0;
        for (const [first, last, modules] of sections) {
          const scale = (edges[last] - edges[first]) / modules;
          if (Math.abs(scale / pitch - 1) > 0.25) break;
          let previous = 0;
          for (let j = first; j < last; j++) {
            const next = Math.round((edges[j + 1] - edges[first]) / scale);
            const width = next - previous, dark = (j - i) % 2 === 0;
            if (width < 1 || width > 12) break;
            if (width > 4) {
              if (!repaired || dark || gapStart >= 0) break;
              gapStart = bits.length;
              gapWidth = width;
            }
            bits += (dark ? "1" : "0").repeat(width);
            previous = next;
          }
          if (previous !== modules) break;
        }
        if (bits.length !== 95 ||
            !bits.startsWith("101") || bits.slice(45, 50) !== "01010" || !bits.endsWith("101")) continue;
        if (repaired && (gapStart < 3 || gapStart + gapWidth > 92)) continue;
        const text = repaired ? restoreErasedEanBar(bits, gapStart, gapWidth) : decodeEan13Modules([...bits], 0)?.text;
        if (text) return { text, left, right, repaired };
      }
    }
  }
  return null;
}

function readEanGuardRows(pixels, deadline) {
  const { width, height, data } = pixels;
  const step = Math.max(4, Math.floor(height / 52));
  const middle = Math.floor(height / 2);
  const row = new Uint8Array(width);
  let match = null, count = 0, top = height, bottom = 0;
  for (let offset = 0; offset <= middle; offset += step) {
    for (const y of offset ? [middle - offset, middle + offset] : [middle]) {
      if (performance.now() >= deadline) return [];
      if (y >= height) continue;
      let low = 255, high = 0;
      for (let x = 0; x < width; x++) {
        const value = row[x] = data[(y * width + x) * 4 + 1];
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
      if (high - low < 72) continue;
      // Lower thresholds separate tightly printed dark bars whose narrow
      // spaces are much darker than the surrounding paper.
      for (const level of [0.5, 0.38, 0.33, 0.28, 0.25, 0.2, 0.64]) {
        const threshold = low + (high - low) * level;
        // Treat the first light area as the quiet zone. Cropped or absent
        // quiet zones fail the row check before any repair is attempted.
        const edges = [0];
        let dark = false;
        for (let x = 0; x < width; x++) {
          const next = row[x] <= threshold;
          if (next !== dark) { edges.push(x); dark = next; }
        }
        edges.push(width);
        const hit = readEanGuardRow(edges, deadline);
        if (!hit) continue;
        if (match && (match.text !== hit.text || Math.abs(match.left - hit.left) > width * 0.08 ||
            Math.abs(match.right - hit.right) > width * 0.08)) return [];
        match ||= hit;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        if (++count >= 4) {
          const { text, left, right, repaired } = match;
          return [{ isValid: true, text, format: "EAN13", repaired, position: {
            topLeft: { x: left, y: top }, topRight: { x: right, y: top },
            bottomRight: { x: right, y: bottom }, bottomLeft: { x: left, y: bottom }
          } }];
        }
        break;
      }
    }
  }
  return [];
}

// Recover faint EAN-13s directly from the module guards when a photographic
// image leaves too little contrast for ZXing's general-purpose binarizers.
// This is restricted to an already isolated label/candidate region; valid
// checksums and the page's independent-frame confirmation remain mandatory.
function readEan13Scanlines(pixels, deadline, topRatio = 0.42, bottomRatio = 0.94) {
  const { width, height, data } = pixels;
  const yStart = Math.max(0, Math.floor(height * topRatio));
  const yEnd = Math.min(height, Math.ceil(height * bottomRatio));
  const votes = new Map();
  for (let y = yStart; y < yEnd; y += 2) {
    if (performance.now() >= deadline) break;
    const values = new Uint8Array(width), histogram = new Uint16Array(256);
    let darkest = 255, lightest = 0;
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      const value = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      values[x] = value; histogram[value]++;
      darkest = Math.min(darkest, value); lightest = Math.max(lightest, value);
    }
    if (lightest - darkest < 24) continue;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * histogram[i];
    let background = 0, backgroundWeight = 0, bestVariance = -1, otsu = (darkest + lightest) >> 1;
    for (let i = 0; i < 256; i++) {
      backgroundWeight += histogram[i];
      if (!backgroundWeight) continue;
      const foregroundWeight = width - backgroundWeight;
      if (!foregroundWeight) break;
      background += i * histogram[i];
      const delta = background / backgroundWeight - (sum - background) / foregroundWeight;
      const variance = backgroundWeight * foregroundWeight * delta * delta;
      if (variance > bestVariance) { bestVariance = variance; otsu = i; }
    }
    const thresholds = [...new Set([otsu,
      Math.round(darkest + (lightest - darkest) * 0.4),
      Math.round(darkest + (lightest - darkest) * 0.5),
      Math.round(darkest + (lightest - darkest) * 0.6)])];
    for (const threshold of thresholds) {
      const runs = [];
      let color = values[0] <= threshold ? 1 : 0, start = 0;
      for (let x = 1; x <= width; x++) {
        const next = x < width && values[x] <= threshold ? 1 : 0;
        if (x === width || next !== color) {
          runs.push({ start, length: x - start, color });
          start = x; color = next;
        }
      }
      for (let i = 0; i + 2 < runs.length; i++) {
        const a = runs[i], b = runs[i + 1], c = runs[i + 2];
        if (a.color !== 1 || b.color !== 0 || c.color !== 1) continue;
        const module = (a.length + b.length + c.length) / 3;
        if (module < 0.8 || Math.max(a.length, b.length, c.length) > module * 1.75 ||
            Math.min(a.length, b.length, c.length) < module * 0.45) continue;
        // Three pixels of a guard may be quantized as 3/2/3 even when the
        // actual module pitch is 2.4px. Search a wider pitch range to absorb
        // blur, JPEG ringing and subpixel camera scaling.
        for (const scale of [0.84, 0.9, 0.96, 1.02, 1.08, 1.14]) {
          const unit = module * scale;
          if (a.start + 95 * unit > width) continue;
          const bits = new Array(95);
          for (let bit = 0; bit < 95; bit++) {
            const x = Math.max(0, Math.min(width - 1, Math.floor(a.start + (bit + 0.5) * unit)));
            bits[bit] = values[x] <= threshold ? "1" : "0";
          }
          const decoded = decodeEan13Modules(bits);
          if (!decoded) continue;
          let vote = votes.get(decoded.text);
          if (!vote) { vote = { text: decoded.text, distance: decoded.distance, rows: new Set(), x: a.start, unit }; votes.set(decoded.text, vote); }
          vote.distance = Math.min(vote.distance, decoded.distance);
          vote.rows.add(y);
        }
      }
    }
  }
  const winner = [...votes.values()].sort((a, b) => b.rows.size - a.rows.size || a.distance - b.distance)[0];
  if (!winner) return [];
  const top = Math.max(0, Math.min(...winner.rows) - 2);
  const bottom = Math.min(height - 1, Math.max(...winner.rows) + 2);
  const x0 = winner.x, x1 = Math.min(width - 1, winner.x + winner.unit * 95);
  return [{ isValid: true, text: winner.text, format: "EAN-13", ean13EvidenceRows: winner.rows.size,
    position: { topLeft: { x: x0, y: top }, topRight: { x: x1, y: top },
      bottomRight: { x: x1, y: bottom }, bottomLeft: { x: x0, y: bottom } } }];
}

// ISO/IEC 15417 Code 128 symbol widths, in symbol-value order.
// Table cross-checked against ZXing Code128Reader.CODE_PATTERNS (Apache-2.0).
const CODE128_WIDTHS = "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112";
const CODE128_PATTERNS = CODE128_WIDTHS.split(" ").map(widths => {
  const mask = [...widths].flatMap((width, i) => Array(Number(width)).fill(i % 2));
  const mean = mask.reduce((sum, value) => sum + value, 0) / mask.length;
  const norm = Math.sqrt(mask.length * mean * (1 - mean));
  return Float32Array.from(mask, value => (value - mean) / norm);
});

function sampleCode128Symbol(row, left, unit, samples) {
  let sum = 0, squared = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = left + (i + 0.5) * unit;
    const floor = Math.floor(x);
    const value = row[floor] + (row[floor + 1] - row[floor]) * (x - floor);
    samples[i] = value;
    sum += value;
    squared += value * value;
  }
  return Math.sqrt(Math.max(0, squared - sum * sum / samples.length));
}

function code128Match(samples, pattern, contrast) {
  let match = 0;
  for (let i = 0; i < samples.length; i++) match += samples[i] * pattern[i];
  return match / contrast;
}

function readCode128Symbols(row, left, unit, count, start, samples) {
  const symbols = [];
  let score = 0;
  for (let i = 1; i < count; i++) {
    const contrast = sampleCode128Symbol(row, left + i * unit * 11, unit, samples);
    if (contrast < 24) return null;
    let best = { value: -1, score: 0 }, second = best;
    for (let value = 0; value < 103; value++) {
      const match = code128Match(samples, CODE128_PATTERNS[value], contrast);
      if (match > best.score) {
        second = best; best = { value, score: match };
      } else if (match > second.score) {
        second = { value, score: match };
      }
    }
    if (best.score < 0.71) return null;
    symbols.push([best, second]);
    score += best.score;
  }
  if (score / symbols.length < 0.83) return null;

  // Limit recovery to numeric retail codes. Both the barcode's own check
  // symbol and the check digit in its payload must agree with the observed bars.
  const data = symbols.slice(0, -1);
  const check = symbols[symbols.length - 1];
  if (check[0].score < 0.82 || check[0].score - check[1].score < 0.06) return null;
  const candidates = new Set();
  for (let alternate = -1; alternate < data.length; alternate++) {
    if (alternate >= 0 && (data[alternate][1].score < 0.70 ||
        data[alternate][0].score - data[alternate][1].score > 0.07)) continue;
    let mode = start, checksum = start, text = "";
    for (let i = 0; i < data.length; i++) {
      const value = data[i][i === alternate ? 1 : 0].value;
      checksum += (i + 1) * value;
      if (mode === 105 && value < 100) text += String(value).padStart(2, "0");
      else if (mode !== 105 && value >= 16 && value <= 25) text += String(value - 16);
      else if (mode !== 105 && value === 99) mode = 105;
      else if (mode === 105 && (value === 100 || value === 101)) mode = value === 100 ? 104 : 103;
      else { text = ""; break; }
    }
    if (checksum % 103 !== check[0].value || !/^(?:\d{8}|\d{12,14})$/.test(text)) continue;
    let digitSum = 0;
    for (let i = 0; i < text.length; i++) digitSum += Number(text[text.length - 1 - i]) * (i % 2 ? 3 : 1);
    if (digitSum % 10 === 0) candidates.add(text);
  }
  return candidates.size === 1 ? { text: [...candidates][0], score: score / symbols.length } : null;
}

function readFadedCode128Row(row, deadline) {
  const starts = [], ends = [];
  // A smooth quiet zone followed by a dark edge makes a plausible boundary.
  // Keep the search local so text and neighbouring labels cannot set its scale.
  for (let x = 10; x < row.length - 11; x++) {
    const inside = (row[x] + row[x + 1]) / 2;
    const before = (row[x - 9] + row[x - 5] + row[x - 2]) / 3;
    const after = (row[x + 3] + row[x + 6] + row[x + 10]) / 3;
    if (before - inside > 22 && Math.abs(row[x - 9] - row[x - 2]) < 12 &&
        row[x - 1] - row[x + 1] > 12) starts.push(x);
    if (after - inside > 22 && Math.abs(row[x + 3] - row[x + 10]) < 12 &&
        row[x + 2] - row[x] > 12) ends.push(x + 2);
  }
  if (starts.length > 30 || ends.length > 30) return null;
  const samples = new Float32Array(11), stopSamples = new Float32Array(13);
  let best = null, conflict = false;
  for (const begin of starts) for (const end of ends) {
    if (end - begin < 90) continue;
    if (performance.now() >= deadline) return null;
    for (let count = 6; count <= 16; count++) {
      for (const startOffset of [-1.5, -0.75, 0, 0.75]) for (const endOffset of [-0.75, 0, 0.75, 1.5]) {
        const left = begin + startOffset, right = end + endOffset;
        const unit = (right - left) / (count * 11 + 13);
        if (unit < 1.05 || unit > 4.5) continue;
        const contrast = sampleCode128Symbol(row, left, unit, samples);
        if (contrast < 29) continue;
        let start = 103, startScore = 0;
        for (let value = 103; value <= 105; value++) {
          const score = code128Match(samples, CODE128_PATTERNS[value], contrast);
          if (score > startScore) { start = value; startScore = score; }
        }
        if (startScore < 0.81) continue;
        const stopContrast = sampleCode128Symbol(row, left + count * 11 * unit, unit, stopSamples);
        if (stopContrast < 28 || code128Match(stopSamples, CODE128_PATTERNS[106], stopContrast) < 0.66) continue;
        const hit = readCode128Symbols(row, left, unit, count, start, samples);
        if (!hit) continue;
        if (best && best.text !== hit.text) conflict = true;
        if (!best || hit.score > best.score) best = { ...hit, left, right };
      }
    }
  }
  return conflict ? null : best;
}

function readFadedCode128(pixels, panel, deadline, top = 0.55, bottom = 0.91) {
  const votes = new Map();
  const row = new Float32Array(panel.width);
  const sampleRadius = Math.max(2, Math.min(5, Math.round(panel.height / 60)));
  const step = sampleRadius * 2 + 1;
  const topEdge = Math.max(sampleRadius, panel.y + Math.round(panel.height * top));
  const bottomEdge = Math.min(pixels.height - sampleRadius, panel.y + Math.round(panel.height * bottom));
  if (topEdge >= bottomEdge) return [];
  // Price labels usually put the barcode below the text. Start there and
  // alternate outward with disjoint groups of rows.
  const middle = topEdge + Math.floor((bottomEdge - 1 - topEdge) / (2 * step)) * step;
  let upper = middle, lower = middle + step;
  while ((upper >= topEdge || lower < bottomEdge) && performance.now() < deadline) {
    const takeUpper = upper >= topEdge && (lower >= bottomEdge || middle - upper <= lower - middle);
    const y = takeUpper ? upper : lower;
    if (takeUpper) upper -= step;
    else lower += step;
    row.fill(0);
    for (let dy = -sampleRadius; dy <= sampleRadius; dy++) {
      const start = ((y + dy) * pixels.width + panel.x) * 4;
      for (let x = 0; x < row.length; x++) row[x] += pixels.data[start + x * 4] / step;
    }
    const hit = readFadedCode128Row(row, deadline);
    if (!hit) continue;
    const vote = votes.get(hit.text);
    if (!vote) { votes.set(hit.text, { ...hit, y }); continue; }
    if (Math.abs(vote.left - hit.left) > 8 || Math.abs(vote.right - hit.right) > 8) continue;
    const left = panel.x + hit.left, right = panel.x + hit.right;
    const y0 = Math.min(vote.y, y) - sampleRadius, y1 = Math.max(vote.y, y) + sampleRadius;
    return [{ isValid: true, text: hit.text, format: "Code128", position: {
      topLeft: { x: left, y: y0 }, topRight: { x: right, y: y0 },
      bottomLeft: { x: left, y: y1 }, bottomRight: { x: right, y: y1 }
    } }];
  }
  return [];
}

async function readCompactColourLabel(pixels, panel, options, deadline) {
  if (performance.now() >= deadline) return [];
  const crop = cropBarcodePixels(pixels, panel);
  const directEan = readEan13Scanlines(crop, deadline);
  if (directEan.some(isAcceptedBarcode)) return offsetBarcodePositions(directEan, panel);
  // Keep the common compact-label reads cheap. The enlarged fallback below
  // still gets the decoder's thorough rotations/inversion when needed.
  const candidateOptions = { ...options, tryHarder: false, tryDownscale: false, minLineCount: 1 };
  let results = await readDiagnosticBarcodes(crop, candidateOptions);
  if (results.some(isAcceptedBarcode)) return offsetBarcodePositions(results, panel);
  if (performance.now() >= deadline) return [];

  const normalized = normalizeBarcodePixels(crop, 1);
  if (normalized) {
    results = await readDiagnosticBarcodes(normalized, candidateOptions);
    if (results.some(isAcceptedBarcode)) return offsetBarcodePositions(results, panel);
  }
  if (!normalized || performance.now() >= deadline) return [];

  // The close camera view contains enough detail in compact labels, but some
  // phone decoders need more than one source pixel per EAN module.
  const enlarged = rotateBarcodePixels(normalized, 0, 3);
  const scale = enlarged.width / normalized.width;
  if (scale <= 1 || performance.now() >= deadline) return [];
  results = await decodeBarcodePixels(enlarged, { ...candidateOptions, tryHarder: true, tryDownscale: false },
    { orientation: "auto", thorough: true, enhance: true }, deadline);
  if (!results.some(isAcceptedBarcode)) return [];
  return offsetBarcodePositions(
    restoreRotatedPositions(results, normalized, enlarged, 0, scale), panel);
}

async function verifyRetailRegion(pixels, region, options, deadline, expectedText = "", expectedFormat = "") {
  const matches = result => isAcceptedBarcode(result) &&
    (!expectedText || barcodeText(result) === expectedText) &&
    (!expectedFormat || result.format === expectedFormat);
  const weakReads = [];
  let firstCrop = null;
  for (const [marginX, marginY] of [[0.25, 0.15], [0.45, 0.34]]) {
    if (performance.now() >= deadline) break;
    const px = Math.max(48, region.width * marginX);
    const py = Math.max(32, region.width * marginY, region.height);
    const x = Math.max(0, Math.floor(region.x - px)), y = Math.max(0, Math.floor(region.y - py));
    const rect = { x, y,
      width: Math.min(pixels.width, Math.ceil(region.x + region.width + px)) - x,
      height: Math.min(pixels.height, Math.ceil(region.y + region.height + py)) - y };
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (firstCrop && ["x", "y", "width", "height"].every(key => firstCrop.rect[key] === rect[key])) continue;
    const crop = cropBarcodePixels(pixels, rect);
    firstCrop ||= { crop, rect };
    const strong = await readDiagnosticBarcodes(crop, { ...options, minLineCount: Math.max(4, options.minLineCount || 2) });
    if (strong.some(matches)) {
      if (frameDiagnostics) frameDiagnostics.verificationEvidence = "four-lines";
      return offsetBarcodePositions(strong.filter(matches), rect);
    }
    if (!weakReads.length && expectedFormat === "EAN13" && performance.now() < deadline) {
      const [anchored] = readEanGuardRows(crop, Math.min(deadline, performance.now() + 22));
      if (matches(anchored)) {
        if (frameDiagnostics) frameDiagnostics.verificationEvidence = anchored.repaired ? "four-restored-lines" : "four-guard-lines";
        return offsetBarcodePositions([anchored], rect);
      }
      const corrected = await readThinBars(crop, options);
      if (corrected.some(matches)) {
        if (frameDiagnostics) frameDiagnostics.verificationEvidence = "four-corrected-lines";
        return offsetBarcodePositions(corrected.filter(matches), rect);
      }
    }
    if (performance.now() >= deadline) break;
    // Short/tilted bars may supply only two matching rows. Accept that local
    // read only when a second, wider context agrees on this fresh frame.
    const weak = await readDiagnosticBarcodes(crop, { ...options, minLineCount: 2 });
    const accepted = weak.find(matches);
    weakReads.push(accepted ? { result: accepted, rect } : null);
  }
  if (weakReads.length === 2 && weakReads.every(Boolean) &&
      weakReads[0].result.text === weakReads[1].result.text && weakReads[0].result.format === weakReads[1].result.format) {
    if (frameDiagnostics) frameDiagnostics.verificationEvidence = "two-contexts";
    return offsetBarcodePositions([weakReads[0].result], weakReads[0].rect);
  }
  // Try rotation only after both native crops have had a chance to agree.
  if (firstCrop && expectedText && performance.now() < deadline) {
    const { crop, rect } = firstCrop;
    const angle = estimateBarcodeRotation(crop);
    const angledOptions = { ...options, minLineCount: 4 };
    let angled = await readAngledBarcode(crop, angledOptions, angle, deadline);
    if (!angled.some(matches) && angle && expectedFormat === "EAN13" && performance.now() < deadline) {
      const normalized = normalizeBarcodePixels(crop);
      if (normalized) angled = await readAngledBarcode(normalized, angledOptions, angle, deadline);
    }
    if (angled.some(matches)) {
      if (frameDiagnostics) frameDiagnostics.verificationEvidence = "four-angled-lines";
      return offsetBarcodePositions(angled.filter(matches), rect);
    }
  }
  if (frameDiagnostics) frameDiagnostics.verificationEvidence = weakReads.every(Boolean) && weakReads.length === 2
    ? "conflict" : "incomplete";
  return [];
}

function barcodeText(result) {
  const text = result?.text || "";
  // ZXing 3 normalizes UPC content to EAN-13 internally.
  if (result?.format === "UPCA" && /^0\d{12}$/.test(text)) return text.slice(1);
  if (result?.format === "UPCE" && result.extra) {
    const original = JSON.parse(result.extra).UPCE;
    if (typeof original === "string" && /^\d{8}$/.test(original)) return original;
  }
  return text;
}

async function readBarcodePixels(pixels, options, deadline = Infinity) {
  if (performance.now() >= deadline) return [];
  const initialOptions = options.binarizer === "FixedThreshold"
    ? { ...options, minLineCount: Math.ceil(options.minLineCount * 1.5) } : options;
  let results = await readDiagnosticBarcodes(pixels, initialOptions);
  if (options.tryHarder && options.binarizer !== "FixedThreshold" &&
      !results.some(isAcceptedBarcode) && performance.now() < deadline) {
    // Plain threshold preserves thin bars; require extra matching scan rows.
    results = await readDiagnosticBarcodes(pixels, {
      ...options, binarizer: "FixedThreshold", minLineCount: Math.ceil(options.minLineCount * 1.5)
    });
  }
  return results;
}

// Keep decoded corners in the input frame's coordinates, including manual
// rotation/enlargement fallbacks. The outline never uses guessed edge regions.
function mapBarcodePositions(results, transform) {
  return results.map((result) => {
    if (!isAcceptedBarcode(result) || !result.position) return result;
    const position = {};
    for (const [corner, point] of Object.entries(result.position)) position[corner] = transform(point);
    return { ...result, position };
  });
}

function restoreRotatedPositions(results, original, rotated, angle, enlargement = 1) {
  const radians = angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const rotatedWidth = Math.abs(original.width * cos) + Math.abs(original.height * sin);
  const rotatedHeight = Math.abs(original.width * sin) + Math.abs(original.height * cos);
  const scale = Math.min(enlargement, 1920 / Math.max(rotatedWidth, rotatedHeight));
  return mapBarcodePositions(results, (point) => ({
    x: ((point.x + 0.5 - rotated.width / 2) * cos + (point.y + 0.5 - rotated.height / 2) * sin) / scale + original.width / 2 - 0.5,
    y: (-(point.x + 0.5 - rotated.width / 2) * sin + (point.y + 0.5 - rotated.height / 2) * cos) / scale + original.height / 2 - 0.5
  }));
}

function offsetBarcodePositions(results, rect) {
  return mapBarcodePositions(results, (point) => ({ x: point.x + rect.x, y: point.y + rect.y }));
}

async function readAngledBarcode(pixels, options, angle, deadline) {
  if (!angle || performance.now() >= deadline) return [];
  const rotated = rotateBarcodePixels(pixels, angle);
  const results = await readBarcodePixels(rotated, { ...options, tryHarder: true }, deadline);
  return results.some(isAcceptedBarcode) ? restoreRotatedPositions(results, pixels, rotated, angle) : [];
}

async function decodeBarcodePixels(pixels, options, data, deadline) {
  if (performance.now() >= deadline) return [];
  let results = [], triedRotation = false;
  const fixedAngle = data.orientation === "auto" ? 0 : Number(data.orientation);
  if (Number.isFinite(fixedAngle) && fixedAngle) {
    // A scheduled fixed-angle pass must actually try that angle, even when
    // dense full-frame retries would otherwise exhaust the per-frame budget.
    triedRotation = true;
    const rotated = rotateBarcodePixels(pixels, fixedAngle);
    results = await readBarcodePixels(rotated, { ...options, tryHarder: true }, deadline);
    if (results.some(isAcceptedBarcode)) return restoreRotatedPositions(results, pixels, rotated, fixedAngle);
    if (data.thorough !== false && performance.now() < deadline) {
      invertPixels(rotated);
      results = await readBarcodePixels(rotated, { ...options, tryHarder: true }, deadline);
      if (results.some(isAcceptedBarcode)) return restoreRotatedPositions(results, pixels, rotated, fixedAngle);
    }
  }
  if (!triedRotation || performance.now() < deadline) results = await readBarcodePixels(pixels, options, deadline);
  if (!triedRotation && data.orientation && !results.some(isAcceptedBarcode) && performance.now() < deadline) {
    const angle = data.orientation === "auto" ? estimateBarcodeRotation(pixels) : Number(data.orientation);
    if (Number.isFinite(angle) && angle) {
      const rotated = rotateBarcodePixels(pixels, angle);
      const rotatedOptions = { ...options, tryHarder: true };
      results = await readBarcodePixels(rotated, rotatedOptions, deadline);
      if (data.thorough !== false && !results.some(isAcceptedBarcode) && performance.now() < deadline) {
        invertPixels(rotated);
        results = await readBarcodePixels(rotated, rotatedOptions, deadline);
      }
      if (results.some(isAcceptedBarcode)) return restoreRotatedPositions(results, pixels, rotated, angle);
    }
  }
  if (data.thorough !== false && !results.some(isAcceptedBarcode) && performance.now() < deadline) {
    invertPixels(pixels);
    results = await readBarcodePixels(pixels, options, deadline);
    if (data.enhance !== false && !results.some(isAcceptedBarcode) && performance.now() < deadline) {
      invertPixels(pixels);
      if (prepareContrast(pixels) && performance.now() < deadline) {
        const enhancedOptions = { ...options, binarizer: "FixedThreshold", minLineCount: Math.ceil(options.minLineCount * 1.5) };
        const enhanced = enhanceContrast(pixels);
        if (performance.now() < deadline) results = await readDiagnosticBarcodes(enhanced, enhancedOptions);
        if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
          const inverted = enhanceContrast(pixels, true);
          if (performance.now() < deadline) results = await readDiagnosticBarcodes(inverted, enhancedOptions);
        }
      }
    }
  }
  return results;
}

self.onmessage = async ({ data }) => {
  let pixels, framePreparation;
  try {
    await ready;
    if (data.videoFrame) {
      const preparationStarted = performance.now();
      const prepared = await readCameraFrame(data);
      pixels = prepared.pixels;
      framePreparation = { ...prepared.timings, totalMs: performance.now() - preparationStarted };
    } else {
      pixels = new ImageData(new Uint8ClampedArray(data.buffer), data.width, data.height);
    }
  } catch (_) {
    try { data.videoFrame?.close(); } catch (_) { /* Already closed by extraction. */ }
    self.postMessage({ id: data.id, error: "frame-preparation-failed", framePreparationFailed: true });
    return;
  }
  const started = performance.now();
  frameDiagnostics = data.diagnostics ? { wasmCalls: 0, wasmMs: 0, maxWasmReadMs: 0,
    rejectedResults: 0, reads: [], stage: "initial" } : null;
  const measurements = () => frameDiagnostics ? { ...frameDiagnostics,
    framePreparation,
    workerMs: performance.now() - started, budgetMs: data.budgetMs,
    budgetExceeded: Boolean(data.budgetMs > 0 && performance.now() - started > data.budgetMs),
    workerOverheadMs: Math.max(0, performance.now() - started - frameDiagnostics.wasmMs) } : undefined;
  let focusTarget = null, focusEvidence = null;
  const reportFocus = () => {
    const region = focusEvidence || focusTarget;
    if (data.assistCamera && region) self.postMessage({ id: data.id, type: "focus", region });
  };
  try {
    const options = {
      formats: data.formats,
      tryHarder: data.thorough !== false,
      tryRotate: true,
      tryInvert: true,
      tryDownscale: data.downscale !== false,
      maxNumberOfSymbols: 1,
      textMode: "Plain",
      minLineCount: Math.max(1, data.minLineCount || 2),
      binarizer: data.binarizer || "LocalAverage"
    };
    // One deadline covers the entire frame, including locating candidates.
    // Never restart it for another stage. An individual WASM read cannot be
    // interrupted, but an expired budget must not start further retries.
    // Direct callers without a budget retain the full fallback behavior.
    const deadline = decodeDeadline = started + (data.budgetMs > 0 ? data.budgetMs : Infinity);
    let results = [], triedScheduledAngle = false;
    const quick = { ...options, tryHarder: false, tryDownscale: false, binarizer: "LocalAverage" };
    const dense = { ...quick, tryHarder: true };
    const preferred = data.preferredRegion;
    if (preferred && [preferred.x, preferred.y, preferred.width, preferred.height].every(Number.isFinite) &&
        preferred.width > 0 && preferred.height > 0) {
      if (frameDiagnostics) frameDiagnostics.stage = "confirmation-region";
      // Confirm a successfully read barcode first, with generous quiet-zone
      // and movement margins. A miss still searches the current full preview.
      const px = Math.max(24, preferred.width * 0.25), py = Math.max(24, preferred.width * 0.18, preferred.height * 0.65);
      const x = Math.max(0, Math.floor(preferred.x - px)), y = Math.max(0, Math.floor(preferred.y - py));
      const width = Math.min(pixels.width, Math.ceil(preferred.x + preferred.width + px)) - x;
      const height = Math.min(pixels.height, Math.ceil(preferred.y + preferred.height + py)) - y;
      if (width > 0 && height > 0) {
        const rect = { x, y, width, height };
        const crop = cropBarcodePixels(pixels, rect);
        const confirmOptions = { ...options, tryDownscale: false, binarizer: "LocalAverage" };
        results = await readDiagnosticBarcodes(crop, confirmOptions);
        if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
          const normalized = normalizeBarcodePixels(crop, 1);
          if (normalized && performance.now() < deadline) results = await readDiagnosticBarcodes(normalized, confirmOptions);
        }
        if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
          results = await decodeBarcodePixels(crop, confirmOptions, data, deadline);
        }
        if (results.some(isAcceptedBarcode)) results = offsetBarcodePositions(results, rect);
      }
    }
    if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
      // Preserve a whole-frame read first: a tight crop can occasionally
      // produce a different, checksum-valid EAN-13 from the same bars.
      if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
        if (frameDiagnostics) frameDiagnostics.stage = "full-frame-quick";
        results = await readDiagnosticBarcodes(pixels, quick);
      }
      if (!results.some(isAcceptedBarcode) && !data.verificationCode && !data.verificationRegion &&
          data.thorough !== false &&
          performance.now() < deadline) {
        // The quick pass samples too few rows for short and reflective labels.
        // Give the native pixels a dense read before expensive angle/crop work.
        if (frameDiagnostics) frameDiagnostics.stage = "full-frame-dense";
        results = await readDiagnosticBarcodes(pixels, { ...dense, tryInvert: false });
      }
      if (!results.some(isAcceptedBarcode) && data.verificationFormat === "EAN13" &&
          pixels.width * pixels.height <= 1100000 && performance.now() < deadline) {
        results = await readContrastEan13(pixels, dense, deadline, data.verificationCode);
        if (results.length && frameDiagnostics) frameDiagnostics.stage = "ean-contrast-verification";
      }
      const verification = data.verificationRegion;
      if (!results.some(isAcceptedBarcode) && performance.now() < deadline && verification &&
          [verification.x, verification.y, verification.width, verification.height].every(Number.isFinite) &&
          verification.width > 0 && verification.height > 0) {
        // Keep full preview context available, but revisit a valid first read
        // before background candidates. Four matching rows reject the thin
        // crop misread found in the supplied EAN-13 label photos.
        if (frameDiagnostics) frameDiagnostics.stage = "retail-verification-region";
        if (data.verificationFormat === "Code128" && options.formats?.includes("Code128")) {
          const x = Math.max(0, Math.floor(verification.x - verification.width * 0.25));
          const y = Math.max(0, Math.floor(verification.y - verification.height * 0.8));
          const width = Math.min(pixels.width, Math.ceil(verification.x + verification.width * 1.25)) - x;
          const height = Math.min(pixels.height, Math.ceil(verification.y + verification.height * 1.8)) - y;
          if (width > 0 && height > 0) {
            const rect = { x, y, width, height };
            const verified = await readDiagnosticBarcodes(cropBarcodePixels(pixels, rect),
              { ...dense, formats: ["Code128"], minLineCount: 4 });
            const matching = result => isAcceptedBarcode(result) && result.text === data.verificationCode;
            if (verified.some(matching)) results = offsetBarcodePositions(verified.filter(matching), rect);
            else results = readFadedCode128(pixels, rect, Math.min(deadline, performance.now() + 24), 0.15, 0.85)
              .filter(matching);
          }
        }
        if (!results.some(isAcceptedBarcode)) {
          const verifyDeadline = data.verificationCode ? Math.min(deadline, performance.now() + 72) : deadline;
          results = await verifyRetailRegion(pixels, verification, dense, verifyDeadline,
            data.verificationCode || "", data.verificationFormat || "");
        }
      }
    }
    if (data.verificationCode && !results.some(isAcceptedBarcode) && performance.now() < deadline) {
      // Make one wider attempt before releasing the worker for a new frame.
      // Confirmation should spend its time on the label, not shelf candidates.
      const height = Math.ceil(pixels.height * 0.44);
      const region = data.verificationRegion;
      const center = Number.isFinite(region?.y + region?.height) ? region.y + region.height / 2 : pixels.height / 2;
      const y = Math.max(0, Math.min(pixels.height - height, Math.round(center - height / 2)));
      const rect = { x: 0, y, width: pixels.width, height };
      if (frameDiagnostics) frameDiagnostics.stage = "retail-verification-band";
      const crop = cropBarcodePixels(pixels, rect);
      const band = await readDiagnosticBarcodes(crop, dense);
      results = offsetBarcodePositions(band.filter(result => isAcceptedBarcode(result) &&
        barcodeText(result) === data.verificationCode &&
        (!data.verificationFormat || result.format === data.verificationFormat)), rect);
      if (!results.length && data.verificationFormat === "EAN13" && performance.now() < deadline) {
        results = offsetBarcodePositions(await readContrastEan13(crop, dense, deadline, data.verificationCode), rect);
      }
    }
    if (!data.verificationCode && !results.some(isAcceptedBarcode) && performance.now() < deadline) {
      let colourPanels = null;
      const phase = Math.abs(data.regionOffset || 0) % 4;
      if (phase === 1 && data.thorough !== false) {
        // Splitting the outer preview into bands shifts ZXing's row sampling
        // and keeps bright background outside a small label's scan.
        if (frameDiagnostics) frameDiagnostics.stage = "outer-band-dense";
        for (const start of [0.03, 0.65]) {
          if (performance.now() >= deadline) break;
          const rect = { x: 0, y: Math.floor(pixels.height * start), width: pixels.width,
            height: Math.ceil(pixels.height * 0.32) };
          results = await readDiagnosticBarcodes(cropBarcodePixels(pixels, rect), { ...dense, tryInvert: false });
          if (results.some(isAcceptedBarcode)) {
            results = offsetBarcodePositions(results, rect);
            break;
          }
        }
      }
      const scheduledAngle = data.orientation === "auto" ? 0 : Number(data.orientation);
      const readAimedAngle = async () => {
        const x = Math.floor(pixels.width * 0.075), y = Math.floor(pixels.height * 0.15);
        const rect = { x, y, width: pixels.width - x * 2, height: pixels.height - y * 2 };
        const angle = estimateBarcodeRotation(pixels, rect);
        if (!angle || performance.now() >= deadline) return [];
        if (frameDiagnostics) frameDiagnostics.stage = "aimed-angle";
        return offsetBarcodePositions(
          await readAngledBarcode(cropBarcodePixels(pixels, rect), dense, angle, deadline), rect);
      };
      if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
        if (Number.isFinite(scheduledAngle) && scheduledAngle) {
          // Give steep/off-center barcodes a turn before shelf and text searches.
          triedScheduledAngle = true;
          if (frameDiagnostics) frameDiagnostics.stage = "scheduled-angle";
          results = await readAngledBarcode(pixels, options, scheduledAngle, deadline);
        } else if (phase === 1 && !data.adaptiveFocus) {
          results = await readAimedAngle();
        }
      }
      let centerBand = null, centerStrips = null;
      const bandY = Math.floor(pixels.height * 0.35);
      if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
        if (frameDiagnostics) frameDiagnostics.stage = "center-strip-priority";
        centerBand = cropBarcodePixels(pixels, { x: 0, y: bandY, width: pixels.width,
          height: Math.ceil(pixels.height * 0.3) });
        results = await readDiagnosticBarcodes(centerBand, dense);
        if (!results.some(isAcceptedBarcode) && options.formats?.includes("EAN13") && performance.now() < deadline) {
          results = readEanGuardRows(centerBand, Math.min(deadline, performance.now() + 22));
          if (results.length && frameDiagnostics) frameDiagnostics.stage = results[0].repaired ? "erased-ean-bar" : "ean-guard-rows";
        }
        if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
          results = await readThinBars(centerBand, dense);
        }
        if (results.some(isAcceptedBarcode)) results = offsetBarcodePositions(results, { x: 0, y: bandY });
      }
      if (!results.some(isAcceptedBarcode) && options.formats?.includes("Code128") && performance.now() < deadline) {
        // Try small coloured labels before dense searches of the whole shelf.
        colourPanels = findColourLabelRegions(pixels);
        const labelDeadline = Math.min(deadline, performance.now() + 30);
        if (frameDiagnostics) frameDiagnostics.stage = "faded-code128";
        for (const panel of colourPanels.slice(0, 2)) {
          if (performance.now() >= labelDeadline) break;
          if (panel.score < 0.65 || panel.width > pixels.width * 0.7 ||
              panel.width * panel.height > pixels.width * pixels.height * 0.18) continue;
          results = readFadedCode128(pixels, panel, labelDeadline);
          if (results.some(isAcceptedBarcode)) break;
        }
      }
      if (!results.some(isAcceptedBarcode) && data.adaptiveFocus && centerBand && performance.now() < deadline) {
        // Reuse the strip search for decoding. Preserve its focus observation
        // even if a later fallback exhausts this frame's decoding budget.
        centerStrips = findBarcodeStrips(centerBand).map(rect => ({ ...rect, y: rect.y + bandY }));
        focusEvidence = measureBarcodeFocus(pixels, centerStrips);
      }
      if (phase === 1 && data.adaptiveFocus && !triedScheduledAngle &&
          !results.some(isAcceptedBarcode) && performance.now() < deadline) {
        results = await readAimedAngle();
      }
      if (!results.some(isAcceptedBarcode) && phase % 2 === 0 &&
          options.formats?.includes("EAN13") && performance.now() < deadline) {
        // Dim glossy labels can disappear into the whole-frame intensity
        // range. Normalize a wider aiming band before shelf/angle retries.
        const y = Math.floor(pixels.height * (phase === 0 ? 0.2 : 0.25));
        const rect = { x: 0, y, width: pixels.width, height: pixels.height - 2 * y };
        if (frameDiagnostics) frameDiagnostics.stage = "ean-contrast-band";
        const crop = cropBarcodePixels(pixels, rect);
        if (phase === 2) {
          // Measure the strongest local strip. Gradients elsewhere in the
          // frame can overwhelm the angle of a short barcode on a bottle.
          const [strip] = findBarcodeStrips(crop);
          const angle = strip ? estimateBarcodeRotation(crop, strip) : 0;
          if (angle && performance.now() < deadline) {
            const normalized = normalizeBarcodePixels(cropBarcodePixels(crop, strip));
            if (normalized) {
              const angled = await readAngledBarcode(normalized,
                { ...dense, formats: ["EAN13"], minLineCount: 4 }, angle, deadline);
              results = offsetBarcodePositions(angled, { x: strip.x, y: y + strip.y });
            }
          }
        }
        if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
          results = offsetBarcodePositions(await readContrastEan13(crop, dense, deadline), rect);
        }
      }
      if (!results.some(isAcceptedBarcode) && phase === 3 && performance.now() < deadline) {
        // Spend periodic longer passes on compact coloured labels after the
        // quick full-preview read and any pending retail verification.
        if (frameDiagnostics) frameDiagnostics.stage = "compact-colour-labels";
        colourPanels ||= findColourLabelRegions(pixels);
        for (const panel of colourPanels.slice(0, 4)) {
          if (performance.now() >= deadline) break;
          if (panel.width > pixels.width * 0.7 || panel.width < 72 || panel.height < 28 ||
              panel.width * panel.height > pixels.width * pixels.height * 0.18) continue;
          results = await readCompactColourLabel(pixels, panel, dense, deadline);
          if (results.some(isAcceptedBarcode)) break;
        }
      }
      let globalStrips = [];
      if (!results.some(isAcceptedBarcode) && centerBand && performance.now() < deadline) {
        // Search the aimed center band first. A small retail label should not
        // spend its short frame budget on distant shelves and package text.
        if (frameDiagnostics) frameDiagnostics.stage = "center-strip-priority";
        centerStrips ||= findBarcodeStrips(centerBand).map((rect) => ({ ...rect, y: rect.y + bandY }));
        if (frameDiagnostics) {
          frameDiagnostics.centerStrips = centerStrips.length;
          frameDiagnostics.priorityStrips = centerStrips.slice(0, 3).map(({ x, y, width, height, edges }) =>
            ({ x, y, width, height, edges }));
        }
        for (const rect of centerStrips.slice(0, 3)) {
          if (performance.now() >= deadline) break;
          results = await readBarcodeStrip(pixels, rect, dense, deadline);
          if (results.some(isAcceptedBarcode)) break;
        }
      }
      if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
        // Small yellow price labels can have little edge contrast against the
        // product behind them. Decode compact colour panels before spending
        // the frame budget ranking unrelated shelf and package stripes.
        const panels = colourPanels || findColourLabelRegions(pixels);
        if (frameDiagnostics) frameDiagnostics.stage = "compact-colour-labels";
        for (const panel of panels) {
          if (performance.now() >= deadline) break;
          if (panel.width > pixels.width * 0.7 || panel.width < 72 || panel.height < 28 ||
              panel.width * panel.height > pixels.width * pixels.height * 0.18) continue;
          const crop = cropBarcodePixels(pixels, panel);
          results = readEan13Scanlines(crop, deadline);
          if (results.some(isAcceptedBarcode)) {
            results = offsetBarcodePositions(results, panel);
            break;
          }
          if (performance.now() >= deadline) break;
          results = await readDiagnosticBarcodes(crop, dense);
          if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
            const normalized = normalizeBarcodePixels(crop, 1);
            if (normalized && performance.now() < deadline) {
              results = await readDiagnosticBarcodes(normalized, dense);
            }
          }
          if (results.some(isAcceptedBarcode)) {
            results = offsetBarcodePositions(results, panel);
            break;
          }
          if (performance.now() < deadline) {
            for (const strip of findBarcodeStrips(crop).slice(0, 2)) {
              const rect = { ...strip, x: strip.x + panel.x, y: strip.y + panel.y };
              results = await readBarcodeStrip(pixels, rect, dense, deadline);
              if (results.some(isAcceptedBarcode)) break;
            }
            if (results.some(isAcceptedBarcode)) break;
          }
        }
      }
      if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
        // The full preview remains searchable when the label is off center.
        if (frameDiagnostics) frameDiagnostics.stage = "barcode-strip-priority";
        globalStrips = findBarcodeStrips(pixels);
        if (data.adaptiveFocus && !focusEvidence) focusEvidence = measureBarcodeFocus(pixels, globalStrips);
        if (frameDiagnostics) frameDiagnostics.globalStrips = globalStrips.length;
        for (const rect of globalStrips.slice(0, 3)) {
          if (performance.now() >= deadline) break;
          results = await readBarcodeStrip(pixels, rect, dense, deadline);
          if (results.some(isAcceptedBarcode)) break;
        }
      }
      if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
        const panels = colourPanels || findColourLabelRegions(pixels);
        if (frameDiagnostics) frameDiagnostics.stage = "label-strip-search";
        const local = [];
        if (panels.length) {
          for (const panel of panels) {
            if (performance.now() >= deadline) break;
            // Wide coloured packaging headers are still searched globally;
            // they must not lead ahead of a compact price-label barcode.
            if (panel.width > pixels.width * 0.7) continue;
            for (const strip of findBarcodeStrips(cropBarcodePixels(pixels, panel)).slice(0, 2)) {
              const rect = { ...strip, x: strip.x + panel.x, y: strip.y + panel.y, score: strip.score * panel.score };
              local.push(rect);
              // A compact, central label with enough alternating edges is a
              // useful focus target. It never counts as a decode or an outline.
              if (!focusTarget && panel.score > 0.7 && panel.width < pixels.width * 0.4 &&
                  panel.width * panel.height < pixels.width * pixels.height * 0.12 &&
                  strip.edges >= 40 && strip.edges <= 160 && strip.core.height / strip.core.width >= 0.05) {
                focusTarget = { x: rect.x + strip.core.x, y: rect.y + strip.core.y,
                  width: strip.core.width, height: strip.core.height };
              }
            }
          }
          local.sort((a, b) => b.score - a.score);
        }
        // Remaining whole-frame strips still run when there are no coloured
        // panels, and coloured label crops get their own chance afterwards.
        for (const rect of globalStrips.slice(3).concat(local)) {
          if (performance.now() >= deadline) break;
          results = await readBarcodeStrip(pixels, rect, dense, deadline);
          if (results.some(isAcceptedBarcode)) break;
        }
      }
    }
    // White/angled/vertical labels retain the proven rotation and dense-crop
    // fallbacks. A coloured strip miss must never exclude other barcode types.
    if (!data.verificationCode && !results.some(isAcceptedBarcode) && performance.now() < deadline && focusTarget && Math.abs(data.regionOffset || 0) % 4 !== 3) {
      // A short, blurred barcode benefits from new camera pixels. Avoid slow
      // dense whole-shelf retries while autofocus/camera zoom is settling.
      const px = Math.max(20, focusTarget.width * 0.2), py = Math.max(16, focusTarget.height);
      const x = Math.max(0, Math.floor(focusTarget.x - px)), y = Math.max(0, Math.floor(focusTarget.y - py));
      const rect = { x, y, width: Math.min(pixels.width, Math.ceil(focusTarget.x + focusTarget.width + px)) - x,
        height: Math.min(pixels.height, Math.ceil(focusTarget.y + focusTarget.height + py)) - y };
      const crop = cropBarcodePixels(pixels, rect), normalized = normalizeBarcodePixels(crop, 1);
      if (normalized) {
        const angle = estimateBarcodeRotation(normalized);
        const enlarged = rotateBarcodePixels(normalized, angle, 2);
        results = await decodeBarcodePixels(enlarged, { ...options, tryDownscale: false,
          minLineCount: options.minLineCount * 2 }, { ...data, orientation: "auto" }, deadline);
        if (results.some(isAcceptedBarcode)) results = offsetBarcodePositions(
          restoreRotatedPositions(results, crop, enlarged, angle, 2), rect);
      }
    } else if (!data.verificationCode && !results.some(isAcceptedBarcode) && performance.now() < deadline && data.focused) {
      if (frameDiagnostics) frameDiagnostics.stage = "focused-region-search";
      // Read the whole visible crop first. Background text/stripes must not
      // consume every retry before the real barcode even reaches the reader.
      const quickOptions = { ...options, tryHarder: false, tryDownscale: false,
        minLineCount: options.binarizer === "FixedThreshold" ? Math.ceil(options.minLineCount * 1.5) : options.minLineCount };
      // The preceding strip search already tried sparse LocalAverage rows.
      // Only a different binarizer needs another whole-image sparse read.
      if (options.binarizer !== "LocalAverage") results = await readDiagnosticBarcodes(pixels, quickOptions);
      if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
        const located = findBarcodeRegions(pixels, data.regionOffset);
        if (located.hasContrast) {
          const regions = located.regions;
          const offset = regions.length ? Math.abs(data.regionOffset || 0) % regions.length : 0;
          const plausible = regions.filter((rect) => rect.barPattern);
          const remaining = regions.filter((rect) => !rect.barPattern);
          const ordered = plausible.concat(remaining.map((_, i) => remaining[(offset + i) % remaining.length]));
          const focusedOptions = { ...options, tryDownscale: false };
          const cropOptions = { ...quickOptions, tryHarder: true };
          // Dense rows are necessary for short/distant labels. Check each crop
          // once before spending rotation/contrast retries on a distractor.
          // Unverified candidates never animate the outline.
          for (const rect of ordered) {
            if (performance.now() >= deadline) break;
            const crop = cropBarcodePixels(pixels, rect);
            if (performance.now() >= deadline) break;
            results = await readDiagnosticBarcodes(crop, cropOptions);
            if (results.some(isAcceptedBarcode)) {
              results = offsetBarcodePositions(results, rect);
              break;
            }
          }
          // An angled narrow label can fail native horizontal/vertical rows.
          // Try its own measured angle before costly retries on other regions.
          for (const rect of ordered) {
            if (results.some(isAcceptedBarcode) || performance.now() >= deadline) break;
            const crop = cropBarcodePixels(pixels, rect);
            const angle = estimateBarcodeRotation(crop);
            if (!angle) continue;
            const rotated = rotateBarcodePixels(crop, angle);
            if (performance.now() >= deadline) break;
            results = await readDiagnosticBarcodes(rotated, cropOptions);
            if (results.some(isAcceptedBarcode)) {
              results = offsetBarcodePositions(restoreRotatedPositions(results, crop, rotated, angle), rect);
              break;
            }
          }
          for (const rect of ordered.slice(0, 2)) {
            if (results.some(isAcceptedBarcode) || performance.now() >= deadline) break;
            const crop = cropBarcodePixels(pixels, rect);
            results = await decodeBarcodePixels(crop, focusedOptions, data, deadline);
            if (results.some(isAcceptedBarcode)) {
              results = offsetBarcodePositions(results, rect);
              break;
            }
            if (rect.width <= 700 && rect.height <= 700 && performance.now() < deadline) {
              // Re-create the original crop after potentially inverted retries.
              const original = cropBarcodePixels(pixels, rect);
              const enlarged = rotateBarcodePixels(original, 0, 2);
              results = await decodeBarcodePixels(enlarged,
                { ...focusedOptions, minLineCount: options.minLineCount * 2 }, data, deadline);
              if (results.some(isAcceptedBarcode)) {
                results = offsetBarcodePositions(restoreRotatedPositions(results, original, enlarged, 0, 2), rect);
                break;
              }
            }
          }
          if (!results.some(isAcceptedBarcode) && !triedScheduledAngle && performance.now() < deadline) {
            results = await decodeBarcodePixels(pixels, options, data, deadline);
          }
        }
      }
    } else if (!data.verificationCode && !results.some(isAcceptedBarcode) && !triedScheduledAngle && performance.now() < deadline) {
      results = await decodeBarcodePixels(pixels, options, data, deadline);
    }
    const result = results.find(isAcceptedBarcode);
    let decodedRegion = null, corners = null;
    if (result?.position) {
      const points = Object.values(result.position);
      if (points.length === 4 && points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
        const x = Math.min(...points.map((p) => p.x)), y = Math.min(...points.map((p) => p.y));
        const right = Math.max(...points.map((p) => p.x)), bottom = Math.max(...points.map((p) => p.y));
        decodedRegion = { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
        // Keep all four corners for the live barcode tracking outline.
        corners = points.map((point) => ({ x: point.x, y: point.y }));
        if (data.trackRegions) self.postMessage({ id: data.id, type: "region", region: decodedRegion });
      }
    }
    if (!result) reportFocus();
    const text = barcodeText(result);
    const diagnostics = measurements();
    if (diagnostics) {
      diagnostics.format = result?.format || null;
      diagnostics.candidateRegion = focusEvidence || focusTarget;
      diagnostics.decodedRegion = decodedRegion;
      diagnostics.readsTruncated = diagnostics.wasmCalls > diagnostics.reads.length;
    }
    self.postMessage({ id: data.id, text, format: result?.format || "", corners, region: decodedRegion, diagnostics });
  } catch (error) {
    if (error === decodeBudgetExhausted) {
      if (frameDiagnostics) frameDiagnostics.preprocessingBudgetExhausted = true;
      reportFocus();
      self.postMessage({ id: data.id, text: "", diagnostics: measurements() });
    } else {
      self.postMessage({ id: data.id, error: error.message || "Barcode decoding failed", diagnostics: measurements() });
    }
  } finally {
    frameDiagnostics = null;
    decodeDeadline = Infinity;
  }
};
