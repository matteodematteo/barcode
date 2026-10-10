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
      const gx = data[i + step * 4] - data[i - step * 4];
      const gy = data[i + step * width * 4] - data[i - step * width * 4];
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
function rotateBarcodePixels(pixels, angle) {
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const rotatedWidth = Math.abs(pixels.width * cos) + Math.abs(pixels.height * sin);
  const rotatedHeight = Math.abs(pixels.width * sin) + Math.abs(pixels.height * cos);
  const scale = Math.min(1, 1920 / Math.max(rotatedWidth, rotatedHeight));
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

self.onmessage = async ({ data }) => {
  try {
    await ready;
    const pixels = new ImageData(new Uint8ClampedArray(data.buffer), data.width, data.height);
    const options = {
      formats: data.formats,
      tryHarder: data.thorough !== false,
      tryRotate: true,
      tryInvert: true,
      tryDownscale: true,
      maxNumberOfSymbols: 1,
      textMode: "Plain",
      minLineCount: 2
    };
    let results = await ZXingWASM.readBarcodes(pixels, options);
    if (data.orientation && !results.some(isAcceptedBarcode)) {
      const angle = data.orientation === "auto" ? estimateBarcodeRotation(pixels) : Number(data.orientation);
      if (Number.isFinite(angle) && angle) {
        const rotated = rotateBarcodePixels(pixels, angle);
        const rotatedOptions = { ...options, tryHarder: true };
        results = await ZXingWASM.readBarcodes(rotated, rotatedOptions);
        if (data.thorough !== false && !results.some(isAcceptedBarcode)) {
          invertPixels(rotated);
          results = await ZXingWASM.readBarcodes(rotated, rotatedOptions);
        }
      }
    }
    // ZXing's tryInvert applies to matrix codes. Also support light bars on
    // dark labels for the linear formats used by this app.
    // The heavy contrast-enhancement pair runs only when the page asks for
    // it: empty/moving frames fail here cheaply with original + inverted.
    // Missing flag means full behavior (keeps direct worker callers exact).
    const allowEnhance = data.enhance !== false;
    if (data.thorough !== false && !results.some(isAcceptedBarcode)) {
      invertPixels(pixels);
      results = await ZXingWASM.readBarcodes(pixels, options);
      if (allowEnhance && !results.some(isAcceptedBarcode)) {
        invertPixels(pixels);
        if (prepareContrast(pixels)) {
          const enhancedOptions = { ...options, binarizer: "FixedThreshold", minLineCount: 3 };
          results = await ZXingWASM.readBarcodes(enhanceContrast(pixels), enhancedOptions);
          if (!results.some(isAcceptedBarcode)) {
            results = await ZXingWASM.readBarcodes(enhanceContrast(pixels, true), enhancedOptions);
          }
        }
      }
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
