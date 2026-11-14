# Desktop barcode loading Worker

Create one Cloudflare Worker named **lgkillerbarcodeimport** and paste
`barcode-import.js` into its editor, then deploy. Its expected address is:

`https://lgkillerbarcodeimport.mattoteo96.workers.dev/`

The web app already uses that address in `js/config.js`. If you choose another
Worker name/account, update `barcodeImportProxyEndpoint`, rebuild with
`python build.py`, and copy the resulting deployment files to `github-upload`.

No changes are required to the existing get-info, discount-info, search or print
Workers. The new Worker forwards the web app's saved ERP session. If desired,
`ERP_COOKIE` can be set as a Worker secret; it is optional. Never paste a HAR,
session cookie or password into the public source or GitHub upload.

The single Worker supports three POST actions, based on the supplied HAR:

- `txt`: multipart `file` → `/barCode/uploadTxt`.
- `list`: `page` and `rows` → `/appCollectData/list` (30 rows per page in the app).
- `info`: `id` → `/appCollectData/info?id=…&type=10`.

It only calls these fixed endpoints, does not cache authenticated responses,
and reports expired sessions as HTTP 401 so the app can refresh once. It does
not delete collections, edit products, print labels, or upload files to storage.

Desktop (1024 px and wider) replaces Capture barcode with **Load TXT** and
**LG ERP uploads**. Mobile keeps Capture barcode. Both imports replace the capture
list after successful loading, including an empty ERP collection. Cancel or a
loading/storage failure keeps the current list.

The original get-info and discount-info scripts match the HAR endpoints and need
no changes for alternate barcode support. Web app v196 handles authoritative ERP
alias mappings: a captured alternate code stays in the list, while product edits
send the original primary barcode returned by ERP.

TXT supports UTF-8 and BOM-marked UTF-16, up to 5 MB / 10,000 rows. Use
`barcode,quantity`, tab/semicolon-separated barcode and quantity, or one barcode
per line (quantity 1). Barcodes stay strings, including leading zeros. Quantities
must be positive whole numbers. The file determines row order and quantity even
if ERP omits rows. If TXT upload fails, the app resolves the locally parsed file
through the existing get-info and discount-info Workers instead.

For either import method, missing product details trigger both existing Workers,
with four barcodes at a time and one lookup per distinct missing barcode. Rows
that remain unresolved are kept, with an explicit completion warning. Existing
red missing-info styling remains available for rows with no product information.

Deploy this Worker separately in Cloudflare. Uploading its source to GitHub Pages
does not create or deploy a Worker. The `cloudflare/` folder in `github-upload`
is included as deployment material; the browser does not execute these files.
