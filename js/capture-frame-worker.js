"use strict";

// Camera pixels stay in the decoder worker. A native-size RGBA copy avoids
// drawing the camera into a canvas on the page's UI thread.
self.readCameraFrame = (() => {
  let canvas = null, context = null;
  const round = value => Math.round(value * 100) / 100;

  // Keep the same bounded, scene-dependent estimate used by diagnostics.js.
  function sampleQuality({ width, height, data }) {
    const stepX = Math.max(1, Math.ceil(width / 48)), stepY = Math.max(1, Math.ceil(height / 32));
    let count = 0, sum = 0, sumSq = 0, lapSum = 0, lapSq = 0, dark = 0, bright = 0;
    for (let y = 1; y < height - 1; y += stepY) for (let x = 1; x < width - 1; x += stepX) {
      const i = (y * width + x) * 4;
      const value = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) / 256;
      const lap = 4 * data[i + 1] - data[i - 3] - data[i + 5] - data[i - width * 4 + 1] - data[i + width * 4 + 1];
      count++; sum += value; sumSq += value * value; lapSum += lap; lapSq += lap * lap;
      if (value < 16) dark++;
      if (value > 239) bright++;
    }
    if (!count) return null;
    return { sampleCount: count, meanLuminance: round(sum / count),
      contrastStdDev: round(Math.sqrt(Math.max(0, sumSq / count - (sum / count) ** 2))),
      laplacianVariance: round(Math.max(0, lapSq / count - (lapSum / count) ** 2)),
      darkFraction: round(dark / count), brightFraction: round(bright / count) };
  }

  return async function readCameraFrame(data) {
    const frame = data.videoFrame;
    const timings = { drawMs: 0, readbackMs: 0, diagnosticsMs: 0, transport: "worker-canvas", quality: null };
    try {
      const { sx, sy, sw, sh, outputWidth, outputHeight, videoWidth, videoHeight } = data.geometry;
      if (![sx, sy, sw, sh, outputWidth, outputHeight, videoWidth, videoHeight].every(Number.isFinite)
          || sx < 0 || sy < 0 || sw <= 0 || sh <= 0 || sx + sw > videoWidth || sy + sh > videoHeight
          || !Number.isInteger(outputWidth) || !Number.isInteger(outputHeight) || outputWidth <= 0 || outputHeight <= 0) {
        throw new DOMException("Invalid camera frame geometry", "DataError");
      }

      let pixels;
      const visible = frame.visibleRect;
      // copyTo rect coordinates address coded pixels. A transformed display
      // needs drawImage so crop coordinates continue to match the live preview.
      const nativeCoordinates = frame.displayWidth === videoWidth && frame.displayHeight === videoHeight
        && frame.codedWidth === videoWidth && frame.codedHeight === videoHeight
        && (!visible || (visible.x === 0 && visible.y === 0 && visible.width === videoWidth && visible.height === videoHeight))
        && !frame.rotation && !frame.flip;
      if (sw === outputWidth && sh === outputHeight && nativeCoordinates) {
        const started = performance.now();
        try {
          pixels = new ImageData(outputWidth, outputHeight);
          await frame.copyTo(pixels.data, { format: "RGBA", rect: { x: sx, y: sy, width: sw, height: sh },
            layout: [{ offset: 0, stride: outputWidth * 4 }] });
          timings.transport = "video-frame-copy";
        } catch (error) {
          // No error messages, frame contents, or camera identifiers in traces.
          timings.fallbackReason = error?.name || "Error";
          pixels = null;
        } finally { timings.readbackMs = performance.now() - started; }
      } else {
        timings.fallbackReason = sw !== outputWidth || sh !== outputHeight ? "ScalingRequired" : "DisplayTransform";
      }

      if (!pixels) {
        const drawStarted = performance.now();
        if (!canvas) {
          canvas = new OffscreenCanvas(outputWidth, outputHeight);
          context = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
          if (!context) throw new DOMException("Camera pixel conversion unavailable", "NotSupportedError");
        }
        if (canvas.width !== outputWidth) canvas.width = outputWidth;
        if (canvas.height !== outputHeight) canvas.height = outputHeight;
        context.imageSmoothingEnabled = data.geometry.imageSmoothingEnabled === true || data.geometry.mode === "detail";
        context.drawImage(frame, sx, sy, sw, sh, 0, 0, outputWidth, outputHeight);
        timings.drawMs = performance.now() - drawStarted;
        const readStarted = performance.now();
        pixels = context.getImageData(0, 0, outputWidth, outputHeight);
        timings.readbackMs += performance.now() - readStarted;
      }

      if (data.sampleQuality) {
        const started = performance.now();
        timings.quality = sampleQuality(pixels);
        timings.diagnosticsMs = performance.now() - started;
      }
      return { pixels, timings };
    } finally {
      // Transferred frames own a scarce camera/GPU resource, including on error.
      frame?.close();
    }
  };
})();
