"use strict";

// Keep the wrapper and WASM binary pinned to the same release, served locally.
importScripts("vendor/zxing-wasm/3.1.5/reader.js");
const ready = ZXingWASM.prepareZXingModule({
  overrides: {
    locateFile: (path) => new URL("vendor/zxing-wasm/3.1.5/" + path, self.location.href).href
  },
  fireImmediately: true
});
ready.then(() => self.postMessage({ type: "ready" }))
  .catch((error) => self.postMessage({ type: "error", error: error.message }));

function invertPixels(pixels) {
  for (let i = 0; i < pixels.data.length; i += 4) {
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
  const { width, height } = pixels;
  const stride = width + 1;
  const radius = 24;
  const output = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
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
function estimateBarcodeRotation(pixels) {
  const { width, height, data } = pixels;
  const step = Math.max(2, Math.floor(Math.max(width, height) / 480));
  let xx = 0, yy = 0, xy = 0;
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const i = (y * width + x) * 4 + 1;
      const gx = data[i + 4] - data[i - 4];
      const gy = data[i + width * 4] - data[i - width * 4];
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
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const rotatedWidth = Math.abs(pixels.width * cos) + Math.abs(pixels.height * sin);
  const rotatedHeight = Math.abs(pixels.width * sin) + Math.abs(pixels.height * cos);
  const scale = Math.min(enlargement, 1920 / Math.max(rotatedWidth, rotatedHeight));
  const width = Math.ceil(rotatedWidth * scale), height = Math.ceil(rotatedHeight * scale);
  const output = new ImageData(width, height);
  const source = new Uint8Array(pixels.width * pixels.height);
  for (let i = 0; i < source.length; i++) {
    const p = i * 4;
    source[i] = (pixels.data[p] * 77 + pixels.data[p + 1] * 150 + pixels.data[p + 2] * 29) >> 8;
  }
  const target = new Uint32Array(output.data.buffer);
  target.fill(0xffffffff);
  const dx = cos / scale, dy = -sin / scale;
  for (let y = 0; y < height; y++) {
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

function isAcceptedBarcode(result) {
  if (!result?.isValid) return false;
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
  const { width, height, data } = pixels, tile = 16;
  const cols = Math.ceil(width / tile), rows = Math.ceil(height / tile);
  const hues = new Int8Array(cols * rows); hues.fill(-1);
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
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
    if (hues[start] < 0) continue;
    const hue = hues[start], queue = [start]; hues[start] = -1;
    let left = cols, right = 0, top = rows, bottom = 0;
    for (let next = 0; next < queue.length; next++) {
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
  const { width, height, data } = pixels;
  const step = 4, groups = [];
  for (let y = 2; y < height - 2; y += step) {
    const row = y * width * 4;
    let peaks = [], previousSign = 0, strongest = 0, peakX = 0, lastX = -100;
    const commitGroup = () => {
      if (peaks.length < 24) { peaks = []; return; }
      const x0 = peaks[0], x1 = peaks[peaks.length - 1], span = x1 - x0;
      if (span < 48 || span > width * 0.92) { peaks = []; return; }
      let group = null;
      for (let i = groups.length - 1; i >= 0; i--) {
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

// Normalize a colour channel using the bars' own intensity range, rather than
// a bright shelf/reflection elsewhere in the camera frame.
function normalizeBarcodePixels(pixels, channel = 1, core = null) {
  const { width, height, data } = pixels, hist = new Uint32Array(256);
  const x0 = Math.max(0, Math.floor(core?.x || 0)), y0 = Math.max(0, Math.floor(core?.y || 0));
  const x1 = Math.min(width, Math.ceil(x0 + (core?.width || width)));
  const y1 = Math.min(height, Math.ceil(y0 + (core?.height || height)));
  let count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    hist[data[(y * width + x) * 4 + channel]]++; count++;
  }
  let low = 0, high = 255, sum = 0;
  for (; low < 255; low++) { sum += hist[low]; if (sum >= count * 0.02) break; }
  sum = 0;
  for (; high > low; high--) { sum += hist[high]; if (sum >= count * 0.02) break; }
  if (high - low < 6) return null;
  const output = new ImageData(width, height), gain = 255 / (high - low);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4, value = Math.max(0, Math.min(255, Math.round((data[i + channel] - low) * gain)));
    output.data[i] = output.data[i + 1] = output.data[i + 2] = value; output.data[i + 3] = 255;
  }
  return output;
}

// Locate concentrated parallel edges before resizing/rotating an entire frame.
// Every frame is located independently so changes in distance cannot leave a
// stale crop. All pixel processing stays in this worker (including on iOS).
// Regular packaging stripes have constant black/white run widths. Real
// linear codes contain varied module widths across several adjacent rows.
// This ranks candidates only; the decoder still decides what is a barcode.
function hasBarcodeRunPattern(pixels, rect) {
  const crop = cropBarcodePixels(pixels, rect);
  const angle = -estimateBarcodeRotation(crop) * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const half = Math.min(rect.width / Math.max(0.001, Math.abs(cos)),
    rect.height / Math.max(0.001, Math.abs(sin))) / 2 - 1;
  let matchingRows = 0;
  for (const offset of [-0.06, 0, 0.06]) {
    const shift = Math.min(rect.width, rect.height) * offset;
    const cx = rect.width / 2 - sin * shift, cy = rect.height / 2 + cos * shift;
    const values = [];
    let darkest = 255, lightest = 0;
    for (let d = -half; d <= half; d++) {
      const x = Math.round(cx + cos * d), y = Math.round(cy + sin * d);
      if (x < 0 || y < 0 || x >= crop.width || y >= crop.height) continue;
      const i = (y * crop.width + x) * 4;
      const value = (crop.data[i] * 77 + crop.data[i + 1] * 150 + crop.data[i + 2] * 29) >> 8;
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

function findBarcodeRegions(pixels) {
  const { width, height, data } = pixels;
  const tile = 32, cols = Math.ceil(width / tile), rows = Math.ceil(height / tile);
  const active = new Uint8Array(cols * rows), scores = new Float32Array(active.length);
  let darkest = 255, lightest = 0;
  const luma = (i) => (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  for (let ty = 0; ty < rows; ty++) {
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
    if (!active[start]) continue;
    const queue = [start]; active[start] = 0;
    let left = cols, right = 0, top = rows, bottom = 0, score = 0;
    for (let next = 0; next < queue.length; next++) {
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
  for (const rect of candidates) rect.barPattern = hasBarcodeRunPattern(pixels, rect);
  candidates.sort((a, b) => Number(b.barPattern) - Number(a.barPattern) || b.score - a.score);
  let hasContrast = lightest > darkest;
  if (!hasContrast) {
    // A coarse grid must never discard a thin label between sample points.
    const reference = luma(0);
    for (let i = 4; i < data.length; i += 4) {
      if (luma(i) !== reference) { hasContrast = true; break; }
    }
  }
  return { regions: candidates.slice(0, 8), hasContrast };
}

function cropBarcodePixels(pixels, rect) {
  const output = new ImageData(rect.width, rect.height);
  for (let y = 0; y < rect.height; y++) {
    const start = ((rect.y + y) * pixels.width + rect.x) * 4;
    output.data.set(pixels.data.subarray(start, start + rect.width * 4), y * rect.width * 4);
  }
  return output;
}

async function readBarcodePixels(pixels, options, deadline = Infinity) {
  const initialOptions = options.binarizer === "FixedThreshold"
    ? { ...options, minLineCount: Math.ceil(options.minLineCount * 1.5) } : options;
  let results = await ZXingWASM.readBarcodes(pixels, initialOptions);
  if (options.tryHarder && options.binarizer !== "FixedThreshold" &&
      !results.some(isAcceptedBarcode) && performance.now() < deadline) {
    // Plain threshold preserves thin bars; require extra matching scan rows.
    results = await ZXingWASM.readBarcodes(pixels, {
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

async function decodeBarcodePixels(pixels, options, data, deadline) {
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
      if (prepareContrast(pixels)) {
        const enhancedOptions = { ...options, binarizer: "FixedThreshold", minLineCount: Math.ceil(options.minLineCount * 1.5) };
        results = await ZXingWASM.readBarcodes(enhanceContrast(pixels), enhancedOptions);
        if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
          results = await ZXingWASM.readBarcodes(enhanceContrast(pixels, true), enhancedOptions);
        }
      }
    }
  }
  return results;
}

self.onmessage = async ({ data }) => {
  try {
    await ready;
    const pixels = new ImageData(new Uint8ClampedArray(data.buffer), data.width, data.height);
    const options = {
      formats: data.formats,
      tryHarder: data.thorough !== false,
      tryRotate: true,
      tryInvert: true,
      tryDownscale: data.downscale !== false,
      maxNumberOfSymbols: 1,
      textMode: "Plain",
      minLineCount: Math.max(2, data.minLineCount || 2),
      binarizer: data.binarizer || "LocalAverage"
    };
    // The production page bounds retries so a moving/blurred frame cannot
    // monopolize the decoder. Direct callers retain the full fallback behavior.
    let deadline = performance.now() + (data.budgetMs > 0 ? data.budgetMs : Infinity);
    let results = [], focusTarget = null;
    const preferred = data.preferredRegion;
    if (preferred && [preferred.x, preferred.y, preferred.width, preferred.height].every(Number.isFinite) &&
        preferred.width > 0 && preferred.height > 0) {
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
        results = await ZXingWASM.readBarcodes(crop, confirmOptions);
        if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
          const normalized = normalizeBarcodePixels(crop, 1);
          if (normalized) results = await ZXingWASM.readBarcodes(normalized, confirmOptions);
        }
        if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
          results = await decodeBarcodePixels(crop, confirmOptions, data, deadline);
        }
        if (results.some(isAcceptedBarcode)) results = offsetBarcodePositions(results, rect);
      }
    }
    if (!results.some(isAcceptedBarcode)) {
      // Sparse full-image rows are cheap. Reflective shelves need local colour
      // correction, rather than repeated dense reads of the entire scene.
      const quick = { ...options, tryHarder: false, tryDownscale: false, binarizer: "LocalAverage" };
      results = await ZXingWASM.readBarcodes(pixels, quick);
      if (!results.some(isAcceptedBarcode)) {
        const panels = findColourLabelRegions(pixels);
        if (panels.length) {
          const local = [];
          for (const panel of panels) {
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
          const regions = local.concat(findBarcodeStrips(pixels));
          const dense = { ...quick, tryHarder: true };
          deadline = performance.now() + (data.budgetMs > 0 ? data.budgetMs : Infinity);
          // Try each candidate once before rotating or enlarging a distractor.
          // Original colour can read Code128 even when a green plane cannot.
          for (const rect of regions) {
            if (performance.now() >= deadline) break;
            const crop = cropBarcodePixels(pixels, rect);
            results = await ZXingWASM.readBarcodes(crop, dense);
            if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
              const normalized = normalizeBarcodePixels(crop, 1, rect.core);
              if (normalized) results = await ZXingWASM.readBarcodes(normalized, dense);
            }
            if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
              // Video colour conversion can weaken edge rows. Include the
              // quiet-zone intensity range before spending rotation retries.
              const normalized = normalizeBarcodePixels(crop, 1);
              if (normalized) results = await ZXingWASM.readBarcodes(normalized, dense);
            }
            if (results.some(isAcceptedBarcode)) { results = offsetBarcodePositions(results, rect); break; }
          }
        }
      }
    }
    // White/angled/vertical labels retain the proven rotation and dense-crop
    // fallbacks. A coloured strip miss must never exclude other barcode types.
    deadline = performance.now() + (data.budgetMs > 0 ? data.budgetMs : Infinity);
    if (!results.some(isAcceptedBarcode) && focusTarget && Math.abs(data.regionOffset || 0) % 4 !== 3) {
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
    } else if (!results.some(isAcceptedBarcode) && data.focused) {
      // Read the whole visible crop first. Background text/stripes must not
      // consume every retry before the real barcode even reaches the reader.
      const quickOptions = { ...options, tryHarder: false, tryDownscale: false,
        minLineCount: options.binarizer === "FixedThreshold" ? Math.ceil(options.minLineCount * 1.5) : options.minLineCount };
      // The preceding strip search already tried sparse LocalAverage rows.
      // Only a different binarizer needs another whole-image sparse read.
      if (options.binarizer !== "LocalAverage") results = await ZXingWASM.readBarcodes(pixels, quickOptions);
      if (!results.some(isAcceptedBarcode)) {
        const located = findBarcodeRegions(pixels);
        // Even a slower device gets a crop attempt after locating the label.
        deadline = performance.now() + (data.budgetMs > 0 ? data.budgetMs : Infinity);
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
            results = await ZXingWASM.readBarcodes(crop, cropOptions);
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
            results = await ZXingWASM.readBarcodes(rotated, cropOptions);
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
          if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
            results = await decodeBarcodePixels(pixels, options, data, deadline);
          }
        }
      }
    } else if (!results.some(isAcceptedBarcode)) {
      results = await decodeBarcodePixels(pixels, options, data, deadline);
    }
    const result = results.find(isAcceptedBarcode);
    if (data.trackRegions && result?.position) {
      const points = Object.values(result.position);
      if (points.length === 4 && points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
        const x = Math.min(...points.map((p) => p.x)), y = Math.min(...points.map((p) => p.y));
        const right = Math.max(...points.map((p) => p.x)), bottom = Math.max(...points.map((p) => p.y));
        self.postMessage({ id: data.id, type: "region",
          region: { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) } });
      }
    }
    if (!result && focusTarget && data.assistCamera) {
      self.postMessage({ id: data.id, type: "focus", region: focusTarget });
    }
    let text = result?.text || "";
    // ZXing 3 normalizes UPC content to EAN-13 internally.
    if (result?.format === "UPCA" && /^0\d{12}$/.test(text)) text = text.slice(1);
    if (result?.format === "UPCE" && result.extra) {
      const original = JSON.parse(result.extra).UPCE;
      if (typeof original === "string" && /^\d{8}$/.test(original)) text = original;
    }
    self.postMessage({ id: data.id, text });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message || "Barcode decoding failed" });
  }
};
