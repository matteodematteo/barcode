"use strict";

/* App configuration constants */

const CONFIG = {
    cookieProxyEndpoint: "https://lgkiller.mattoteo96.workers.dev/",
    infoEndpoint: "https://lgerp.cc/goods/ongoodsCode",
    infoProxyEndpoint: "https://lgkillergetinfo.mattoteo96.workers.dev/",
    closestSearchProxyEndpoint: "https://lgkillerclosestsearch.mattoteo96.workers.dev/",
    discountProxyEndpoint: "https://lgkillerdiscountinfo.mattoteo96.workers.dev/",
    salesPerformanceEndpoint: "https://lgerp.cc/sellAccountCode/findGoodsAnalyze",
    // Set this to the deployed Cloudflare Worker URL (see cloudflare/sales-performance-proxy.js).
    salesPerformanceProxyEndpoint: "https://salesperformance.mattoteo96.workers.dev/",
    updateProxyEndpoint: "https://lgkillerupdate.mattoteo96.workers.dev/",
    addProductProxyEndpoint: "https://lgkilleraddproduct.mattoteo96.workers.dev/",
    sendTxtEndpoint: "https://withered-base-e090.mattoteo96.workers.dev/",
    settingsStorageKey: "web_barcode_scanner_settings",
    cookieStorageKey: "web_barcode_scanner_cookie",
    cookieStatusStorageKey: "web_barcode_scanner_cookie_status",
    historyStorageKey: "web_barcode_scanner_history",
    cameraStorageKey: "web_barcode_scanner_camera",
    roiStorageKey: "web_barcode_scanner_roi",
    productInfoSlideStorageKey: "web_barcode_scanner_pi_slide",
    inputModeStorageKey: "web_barcode_scanner_input_mode",
    scrollLockStorageKey: "web_barcode_scanner_scroll_lock",
    scanIntervalMs: 240,
    mobileScanIntervalMs: 170,
    iosScanIntervalMs: 130,
    duplicateScanCooldownMs: 600,
    previewWatchIntervalMs: 3500,
    previewStallThreshold: 2,
    preferredSquareSize: 1080,
    mobilePreferredSquareSize: 1080,
    iosPreferredZoom: 2,
    detectorFormats: [
      "ean_13",
      "ean_8",
      "upc_a",
      "upc_e",
      "code_128",
      "code_39",
      "codabar",
      "itf"
    ],
    detectionCropModes: ["expanded", "visible"],
    resultFields: [
      "id",
      "goods_code",
      "italian_name",
      "store_time",
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
