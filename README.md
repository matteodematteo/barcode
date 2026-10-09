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
python build.py
```

Commit/deploy the generated `js/app.bundle.js`, `js/capture.bundle.js`, and
`css/interface.bundle.css` alongside the source. The nested `js/js` and `css/css`
directories are legacy copies and are not loaded by this app.

The main screen requests one core script and one stylesheet. Camera code loads
on demand. The decoder runs in a worker and transfers pixel buffers without
blocking the interface. The worker stays ready for subsequent captures. Saved
authentication refreshes when a product request needs it. The service worker
registers after initial paint, caches capture assets for offline use, and serves
installed navigation immediately while refreshing HTML in the background.

The vendored reader and WASM are pinned together to **ZXing WASM 3.1.5**. Their
npm tarball integrity was verified during import. See the vendor README for the
binary SHA-256. When changing deployed assets, bump their version URLs, the
worker cache name, and the HTML/service-worker app version together.

## Browser checks

With the local server running, install the optional test dependency and run:

```powershell
python -m pip install playwright
python tests/test_capture.py
```

Tests use installed Microsoft Edge, fake cameras, an independently encoded
EAN-13 fixture, and stubbed product lookups. They never contact the live ERP.
They cover responsive layout, no camera/decoder startup work, immediate return,
repeat capture, cancellation during permissions, Back/Escape, denied permissions,
camera release, and installed offline startup/capture. Screenshots and fixtures
are written to the system temporary `webscanner-qa` directory.
