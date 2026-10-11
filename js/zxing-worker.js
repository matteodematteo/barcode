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

// Locate concentrated parallel edges before resizing/rotating an entire frame.
// Every frame is located independently so changes in distance cannot leave a
// stale crop. All pixel processing stays in this worker (including on iOS).
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
  let hasContrast = lightest > darkest;
  if (!hasContrast) {
    // A coarse grid must never discard a thin label between sample points.
    const reference = luma(0);
    for (let i = 4; i < data.length; i += 4) {
      if (luma(i) !== reference) { hasContrast = true; break; }
    }
  }
  return { regions: regions.slice(0, 4), hasContrast };
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

async function decodeBarcodePixels(pixels, options, data, deadline) {
  let results = await readBarcodePixels(pixels, options, deadline);
  if (data.orientation && !results.some(isAcceptedBarcode) && performance.now() < deadline) {
    const angle = data.orientation === "auto" ? estimateBarcodeRotation(pixels) : Number(data.orientation);
    if (Number.isFinite(angle) && angle) {
      const rotated = rotateBarcodePixels(pixels, angle);
      const rotatedOptions = { ...options, tryHarder: true };
      results = await readBarcodePixels(rotated, rotatedOptions, deadline);
      if (data.thorough !== false && !results.some(isAcceptedBarcode) && performance.now() < deadline) {
        invertPixels(rotated);
        results = await readBarcodePixels(rotated, rotatedOptions, deadline);
      }
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
    let results = [];
    if (data.focused) {
      const located = findBarcodeRegions(pixels);
      // Give even slower devices a decoding attempt after locating the label.
      deadline = performance.now() + (data.budgetMs > 0 ? data.budgetMs : Infinity);
      if (located.hasContrast) {
        const regions = located.regions;
        const offset = regions.length ? Math.abs(data.regionOffset || 0) % regions.length : 0;
        for (let candidate = 0; candidate < Math.min(2, regions.length); candidate++) {
          const rect = regions[(offset + candidate) % regions.length];
          if (performance.now() >= deadline) break;
          const crop = cropBarcodePixels(pixels, rect);
          const focusedOptions = { ...options, tryDownscale: false };
          results = await decodeBarcodePixels(crop, focusedOptions, data, deadline);
          if (results.some(isAcceptedBarcode)) break;
          if (rect.width <= 700 && rect.height <= 700 && performance.now() < deadline) {
            // Re-create the unmodified crop: inverted retries may have changed it.
            const enlarged = rotateBarcodePixels(cropBarcodePixels(pixels, rect), 0, 2);
            results = await decodeBarcodePixels(enlarged,
              { ...focusedOptions, minLineCount: options.minLineCount * 2 }, data, deadline);
            if (results.some(isAcceptedBarcode)) break;
          }
        }
        if (!results.some(isAcceptedBarcode) && performance.now() < deadline) {
          results = await decodeBarcodePixels(pixels, options, data, deadline);
        }
      }
    } else {
      results = await decodeBarcodePixels(pixels, options, data, deadline);
    }
    const result = results.find(isAcceptedBarcode);
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
