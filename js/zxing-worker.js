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
    // ZXing's tryInvert applies to matrix codes. Also support light bars on
    // dark labels for the linear formats used by this app.
    // The heavy contrast-enhancement pair runs only when the page asks for
    // it: empty/moving frames fail here cheaply with original + inverted.
    // Missing flag means full behavior (keeps direct worker callers exact).
    const allowEnhance = data.enhance !== false;
    if (data.thorough !== false && !results.some((result) => result.isValid)) {
      invertPixels(pixels);
      results = await ZXingWASM.readBarcodes(pixels, options);
      if (allowEnhance && !results.some((result) => result.isValid)) {
        invertPixels(pixels);
        if (prepareContrast(pixels)) {
          const enhancedOptions = { ...options, binarizer: "FixedThreshold", minLineCount: 3 };
          results = await ZXingWASM.readBarcodes(enhanceContrast(pixels), enhancedOptions);
          if (!results.some((result) => result.isValid)) {
            results = await ZXingWASM.readBarcodes(enhanceContrast(pixels, true), enhancedOptions);
          }
        }
      }
    }
    const result = results.find((result) => result.isValid);
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
