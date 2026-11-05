"use strict";

/* App configuration constants */

const CONFIG = {
    cookieProxyEndpoint: "https://lgkiller.mattoteo96.workers.dev/",
    infoEndpoint: "https://lgerp.cc/goods/ongoodsCode",
    infoProxyEndpoint: "https://lgkillergetinfo.mattoteo96.workers.dev/",
    closestSearchProxyEndpoint: "https://lgkillerclosestsearch.mattoteo96.workers.dev/",
    discountProxyEndpoint: "https://lgkillerdiscountinfo.mattoteo96.workers.dev/",
    // Set this to the deployed Cloudflare Worker URL (see cloudflare/sales-performance-proxy.js).
    salesPerformanceProxyEndpoint: "https://salesperformance.mattoteo96.workers.dev/",
    updateProxyEndpoint: "https://lgkillerupdate.mattoteo96.workers.dev/",
    addProductProxyEndpoint: "https://lgkilleraddproduct.mattoteo96.workers.dev/",
    sendTxtEndpoint: "https://withered-base-e090.mattoteo96.workers.dev/",
    settingsStorageKey: "web_barcode_scanner_settings",
    cookieStorageKey: "web_barcode_scanner_cookie",
    cookieStatusStorageKey: "web_barcode_scanner_cookie_status",
    historyStorageKey: "web_barcode_scanner_history",
    printRequestStorageKey: "web_barcode_scanner_print_requests_v1",
    printTunnelStorageKey: "web_barcode_scanner_print_tunnel_v1",
    cameraStorageKey: "web_barcode_scanner_camera",
    productInfoSlideStorageKey: "web_barcode_scanner_pi_slide",
    scrollLockStorageKey: "web_barcode_scanner_scroll_lock",
    scanIntervalMs: 16,
    mobileScanIntervalMs: 16,
    iosScanIntervalMs: 16,
    duplicateScanCooldownMs: 600,
    // Two fresh reads of the same value and symbology inside this window.
    // Up to 2 missed frames are tolerated; 3 consecutive misses discard the candidate.
    confirmationWindowMs: 1000,
    confirmationRequiredReads: 2,
    confirmationMaxMisses: 3,
    // Centered 240 x 130 dp aim window matching the APK capture architecture.
    // Actual CSS pixels are read from #scanReticle so the decoder gate always
    // matches what the operator sees.
    reticleTargetWidth: 240,
    reticleTargetHeight: 130,
    reticleWidthRatio: 0.84,
    reticleHeightRatio: 0.32,
    // Reticle-first analysis stays close to 720p even on high-resolution sensors.
    reticleAnalysisMaxWidth: 1280,
    reticleAnalysisMaxHeight: 720,
    reticleAnalysisMaxPixels: 921600,
    reticleDetailMaxScale: 2,
    // Focus system parity with APK: 700 ms next-scan reuse, 0.01 tolerance lock,
    // 90-sample focus distance ring buffer, 100 ms frame timestamp match window.
    focusMemoryWindowMs: 700,
    focusDistanceTolerance: 0.01,
    focusMeteringPointSize: 0.15,
    focusAutoCancelMs: 1500,
    focusStartupRetryMs: 350,
    focusSampleBufferMax: 90,
    focusMatchWindowMs: 100,
    // Bounded preview-stall recovery: 4 x 1.5 s = 6 s of no new frames.
    previewWatchIntervalMs: 1500,
    previewStallThreshold: 4,
    previewRecoveryMaxAttempts: 2,
    previewHealthResetMs: 15000,
    preferredSquareSize: 1080,
    mobilePreferredSquareSize: 1080,
    detectorFormats: [
      "ean_13",
      "ean_8",
      "upc_a",
      "upc_e",
      "code_128",
      "code_39",
      "codabar",
      "itf_14",
      "code_93",
      "data_bar",
      "data_bar_expanded"
    ],
    detectionCropModes: ["expanded", "visible"],
    resultFields: [
      "id",
      "goods_code",
      "italian_name",
      "create_time",
      "p_price",
      "s_price",
      "real_inventory",
      "discount_price",
      "discount_percent",
      "disc_price_percent",
      "disc_cost",
      "disc_iva",
      "supplier_name",
      "spec"
    ],
    // Request full HD immediately; keep this resolution throughout capture.
    cameraStartupVideo: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 }
    },
    videoConstraints: {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        aspectRatio: { ideal: 16 / 9 },
        frameRate: { ideal: 30, max: 30 },
        resizeMode: "crop-and-scale"
      }
    },
    mobileVideoConstraints: {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        aspectRatio: { ideal: 16 / 9 },
        frameRate: { ideal: 30, max: 30 },
        resizeMode: "crop-and-scale"
      }
    },
    iosVideoConstraints: {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 }
      }
    },
    androidVideoConstraints: {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        aspectRatio: { ideal: 16 / 9 },
        frameRate: { ideal: 30, max: 30 },
        resizeMode: "crop-and-scale"
      }
    }
  };
