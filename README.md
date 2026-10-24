# Web Scanner

A dependency-free barcode scanner and product lookup app. Tap **Capture barcode**
to open the dedicated capture screen. A barcode confirmed on two fresh camera
frames returns to the main screen immediately; product lookup continues there.
After capture, decoding pauses and the camera stays active behind the main
screen for the next Capture tap. Back, Escape, leaving the page, and
backgrounding the app release the camera. Returning to the main screen after
backgrounding leaves it off until Capture is tapped again.

## Run locally

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

Open http://localhost:8765. Camera access requires localhost or HTTPS.
Deploy this directory to an HTTPS static host; no build server is required.
Upload `index.html`, `sw.js`, `manifest.webmanifest`, the three icon PNGs, and
the `css/` and `js/` folders including `js/vendor/`. The `docs/`, `previews/`,
and `tests/` folders are optional and are not loaded by the webapp.

## Source and builds

Edit the top-level `js/*.js` and `css/*.css` source files, then run:

```powershell
python -m pip install -r requirements-build.txt
python build.py
```

The pinned Python minifiers are build-only dependencies; the deployed app
requires no packages. Readable source modules remain available for edits.
Set `APP_VERSION` in `sw.js` before building a release. The build synchronizes
the HTML version, manifest, icon URLs (including the header), JS/CSS URLs,
preview pages, and service-worker cache name from that value.

Commit/deploy the generated `js/app.bundle.js`, `js/capture.bundle.js`, and
`css/interface.bundle.css` alongside the source. The nested `js/js` and `css/css`
directories are legacy copies and are not loaded by this app.

Lookup and product details share one compact card; there is no external scanner
mode. The main screen requests one core script and one stylesheet. Camera code
and the decoder warm after first paint, without requesting camera permission.
Capture requests hardware synchronously in the button's click, in parallel with
any remaining code loading, and shows video before decoding is ready.
The initial request prefers 1920×1080 with no forced aspect ratio or software
resize mode. There is no resolution switch during scanning. Custom focus
constraints run after playback begins and preserve the requested resolution. Pointer/focus
on Capture also warms the decoder without opening hardware.

The camera requests continuous autofocus when available and configures the lens
as soon as playback starts, without waiting for the decoder. Tap or click the
preview to select a focus point; a yellow target marks the selected location.
Taps keep continuous autofocus aimed at the selected point for the rest of that
capture, without a delayed switch to another focus mode. Cameras that only offer
single-shot focus still use it. Automatic barcode assistance does not change
hardware zoom or override a selected point. The app maps
the selected point through the preview crop and preserves resolution and torch
settings. The hint reports when point focus is unavailable on a browser or lens.
"Focus requested" acknowledges the camera command; the browser cannot confirm
that the physical image is sharp.
The decoder runs in a worker and transfers pixel buffers without
blocking the interface. The worker and live camera stay ready for subsequent
captures while the app remains visible. Saved
authentication refreshes in the background on startup, when the app reopens,
and after reconnecting. Product requests share an in-flight refresh; startup and
capture stay usable while login completes. The service worker
registers after initial paint, caches capture assets for offline use, and serves
installed navigation immediately while refreshing HTML in the background.

The vendored reader and WASM are pinned together to **ZXing WASM 3.1.5**. Their
npm tarball integrity was verified during import. See the vendor README for the
binary SHA-256. When changing deployed assets, bump `APP_VERSION` in `sw.js`
and rebuild; asset URLs, the cache name, and the HTML version update together.

Capture reads linear product barcodes across the camera image, including EAN-13,
EAN-8, UPC, Code 128 / GS1-128 (EAN-128), Code 39/93, Codabar, GS1 DataBar, and
checksum-validated ITF-14. QR, Data Matrix, Aztec, and PDF417 are disabled.
EAN and GS1-128 remain 1D symbologies; omnidirectional image scanning means the
label can be horizontal, vertical, or diagonal. A failed full-preview read gets
an estimated-angle correction in the worker, with additional angle passes for
cluttered backgrounds. Barcode regions are located again on each frame;
enlargement, rotation and lighting correction prefer those small regions.
Whole-preview reads still cover larger labels and background clutter. Optional
fallbacks share one budget per frame, including candidate location: most attempts
allow 60 ms, with 240 ms every fourth attempt and when confirming a read.
Budget expiry skips further retries so capture can use a newer frame. A running
WASM read or pixel transform finishes before yielding, so these are retry budgets
rather than hard capture-time limits. Scheduled angle passes run before candidate
search to preserve difficult angled reads. Successful ordinary reads skip extra work.
Android and iPhone share the same typed-array implementation, without requiring
OffscreenCanvas or native BarcodeDetector. Capture keeps its 1080p stream and
requires two matching fresh frames before returning to the main page.

Capture status labels stay compact in a fixed-height, single-line footer.
Their font scales with viewport width; full diagnostic text remains in the
status accessibility label/title and the error overlay. The retry button
overlays the preview, so showing it cannot shrink the camera view.

Sales Period uses manual Start and End date fields, with Apply, Clean, and Back.
Last 30 days remains the initial date range. Clean clears both dates before Apply.

Capture-list actions use compact Delete, Clear list, and Print buttons, followed
by a green **+ More** control. Its active switch is pale yellow (RGB 255, 244, 202).
Quantity mode shows a lighter, disabled keypad until a barcode is present.
The keypad has three columns: 1–3, 4–6, 7–9, then C, 0, and an icon-only delete
key. A taller Enter / Add button spans the final row.
Capture, typing, closest-match selection, clearing, submission, and update-draft
restoration refresh that state without adding camera or network startup work.

## Browser checks

Focus regressions can be checked without hardware:

```powershell
node tests/test_focus.cjs
```

With Playwright installed (`npm install --no-save playwright`) and Microsoft
Edge available, run `node tests/test_focus_browser.cjs`. It starts its own local
server and checks the deployed bundles with fake video and simulated lens
controls, including decoder delays, rapid taps, unsupported controls, camera
reuse, and cancellation. Physical autofocus still requires testing on a phone.

With the local server running, install the optional test dependency and run:

```powershell
python -m pip install playwright
python tests/test_capture.py
python tests/test_camera_startup.py
python tests/test_camera_retention.py
python tests/test_frame_budget.py
python tests/test_frame_budget.py --engine webkit
python tests/test_sales_period.py
```

For rotated linear fixtures and mobile browser decoding checks:

```powershell
python -m pip install Pillow qrcode zxing-cpp
python tests/test_linear_capture.py
```

These packages only generate test images; the webapp has no new runtime downloads.
Use `--engine chromium` or `--engine webkit` to check a browser separately.
The test covers EAN and Code 128 / GS1-128 at 16 angles, inverted/low-contrast
images, rejection of matrix codes, empty frames, camera permissions, and Android
camera capture fixtures. ITF is restricted to valid retail ITF-14 to reject
short or incomplete reads that have no mandatory checksum.
WebKit exercises real decoding with mocked permissions; physical phone camera
autofocus and lighting still require device testing.

Earlier Windows mobile-browser QA passed with Playwright 1.58.0 and
WebKit 26.0. The locally installed Playwright 1.63.0 / WebKit 26.6 runtime timed
out even on blank pages, so a separate test runtime was used. Subsequent WebKit
startup attempts were also intermittent; the successful run covered all seven
linear fixtures at 16 angles and rejection of the four matrix-code fixtures.

Tests use installed Microsoft Edge, fake cameras, an independently encoded
EAN-13 fixture, and stubbed product lookups. They never contact the live ERP.
They cover responsive layout, no camera hardware on startup, immediate return,
repeat capture, cancellation during permissions, Back/Escape, denied permissions,
camera reuse between captures, release on backgrounding/navigation, and installed
offline startup/capture. Screenshots and fixtures
are written to the system temporary `webscanner-qa` directory.
The startup check also holds the camera bundle back to verify early preview,
checks full-HD startup and stable resolution on one stream, and covers canceled focus/torch changes.

For Android emulation and WebKit with an iPhone viewport/user agent:

```powershell
python -m playwright install webkit
python tests/test_mobile_compat.py
python tests/test_capture_layout.py
```

The Android test captures a real barcode from fake video. WebKit checks the
iOS constraints, inline video, gesture and denied-permission paths, compact
layout, and actual worker/WASM decoding. WebKit's Windows port uses a mocked
camera permission API; these checks do not replace physical phone testing.
The layout check covers one-line capture statuses from 280px through landscape
widths, stable camera geometry including retry, and bounded history rendering.

To check the update notice and Reload flow (starts its own local server):

```powershell
python tests/test_updates.py
python tests/test_history_controls.py
```

This installs a previous release, serves the current release under the same
subfolder, and verifies that Reload appears. It checks new CSS/JS loading,
preserved input drafts and saved data, and offline decoder initialization.
