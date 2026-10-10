# Web Scanner

A dependency-free barcode scanner and product lookup app. Tap **Capture barcode**
to open the dedicated capture screen. A barcode confirmed on two fresh camera
frames returns to the main screen immediately; product lookup continues there.
Back, Escape, capture timeout, and backgrounding release the camera.

## Run locally

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

Open http://localhost:8765. Camera access requires localhost or HTTPS.
Deploy this directory to an HTTPS static host; no build server is required.

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
The decoder runs in a worker and transfers pixel buffers without
blocking the interface. The worker stays ready for subsequent captures. Saved
authentication refreshes when a product request needs it. The service worker
registers after initial paint, caches capture assets for offline use, and serves
installed navigation immediately while refreshing HTML in the background.

The vendored reader and WASM are pinned together to **ZXing WASM 3.1.5**. Their
npm tarball integrity was verified during import. See the vendor README for the
binary SHA-256. When changing deployed assets, bump `APP_VERSION` in `sw.js`
and rebuild; asset URLs, the cache name, and the HTML version update together.

Capture status labels stay compact in a fixed-height, single-line footer.
Their font scales with viewport width; full diagnostic text remains in the
status accessibility label/title and the error overlay. The retry button
overlays the preview, so showing it cannot shrink the camera view.

Sales Period offers Today, Last 30 days, Last 90 days, and the existing calendar
presets. Last 30 days is the initial default; the matching preset is highlighted
and focused when opening the dialog. Clean clears both dates before Apply.

## Browser checks

With the local server running, install the optional test dependency and run:

```powershell
python -m pip install playwright
python tests/test_capture.py
python tests/test_camera_startup.py
python tests/test_sales_period.py
```

Tests use installed Microsoft Edge, fake cameras, an independently encoded
EAN-13 fixture, and stubbed product lookups. They never contact the live ERP.
They cover responsive layout, no camera hardware on startup, immediate return,
repeat capture, cancellation during permissions, Back/Escape, denied permissions,
camera release, and installed offline startup/capture. Screenshots and fixtures
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
```

This installs a previous release, serves the current release under the same
subfolder, and verifies that Reload appears. It checks new CSS/JS loading,
preserved input drafts and saved data, and offline decoder initialization.
