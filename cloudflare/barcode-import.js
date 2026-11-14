/* Deploy as lgkillerbarcodeimport. Uses the caller's ERP session; no login
   credentials or HAR cookies belong in this source. Optional secret: ERP_COOKIE. */
const ERP_ORIGIN = "https://www.lgerp.cc";
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function reply(payload, status, cors) {
  return new Response(JSON.stringify(payload), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
}

export default {
  async fetch(request, env = {}) {
    const cors = {
      "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "private, no-store", Vary: "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return reply({ error: "Use POST." }, 405, cors);
    let timer;
    try {
      const length = Number(request.headers.get("Content-Length"));
      if (length > MAX_FILE_BYTES + 65536) return reply({ error: "Request is too large." }, 413, cors);
      const form = await request.formData();
      const action = String(form.get("action") || "");
      const cookie = String(form.get("cookie") || env.ERP_COOKIE || "").trim();
      if (!cookie) return reply({ error: "ERP session required." }, 401, cors);
      if (/[\r\n]/.test(cookie)) return reply({ error: "Invalid ERP session." }, 400, cors);
      const headers = new Headers({
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: ERP_ORIGIN + "/index", "X-Requested-With": "XMLHttpRequest", Cookie: cookie
      });
      let target, method, body;
      if (action === "txt") {
        const file = form.get("file");
        if (!file || typeof file === "string" || !file.size) return reply({ error: "Choose a TXT file." }, 400, cors);
        if (file.size > MAX_FILE_BYTES) return reply({ error: "TXT exceeds 5 MB." }, 413, cors);
        target = ERP_ORIGIN + "/barCode/uploadTxt";
        method = "POST";
        body = new FormData();
        body.set("file", file, file.name || "barcodes.txt");
      } else if (action === "list") {
        const page = String(form.get("page") || "1"), rows = String(form.get("rows") || "30");
        if (!/^[1-9]\d{0,6}$/.test(page) || !["30", "100"].includes(rows)) return reply({ error: "Invalid page." }, 400, cors);
        target = ERP_ORIGIN + "/appCollectData/list";
        method = "POST";
        body = new URLSearchParams({ page, rows });
      } else if (action === "info") {
        const id = String(form.get("id") || "");
        if (!/^[1-9]\d{0,14}$/.test(id)) return reply({ error: "Invalid upload ID." }, 400, cors);
        // type=10 is the barcode-label collection format observed in the HAR.
        target = ERP_ORIGIN + "/appCollectData/info?" + new URLSearchParams({ id, type: "10" });
        method = "GET";
      } else return reply({ error: "Unknown loading action." }, 400, cors);

      const timeout = new AbortController();
      timer = setTimeout(() => timeout.abort(), 25000);
      const upstream = await fetch(target, { method, headers, ...(body ? { body } : {}),
        redirect: "manual", cache: "no-store", signal: timeout.signal });
      if ([301, 302, 303, 307, 308, 401, 403].includes(upstream.status) ||
          (upstream.ok && /text\/html/i.test(upstream.headers.get("Content-Type") || ""))) {
        await upstream.body?.cancel();
        return reply({ error: "ERP session expired." }, 401, cors);
      }
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return reply({ error: "ERP loading request failed." }, upstream.status === 429 ? 429 : 502, cors);
      }
      const text = await upstream.text();
      if (/^\s*</.test(text)) return reply({ error: "ERP session required." }, 401, cors);
      let payload;
      try { payload = JSON.parse(text); }
      catch { return reply({ error: "ERP returned an unreadable response." }, 502, cors); }
      if (payload?.success === false || (payload?.code !== undefined && Number(payload.code) !== 0)) {
        return reply({ error: "ERP could not load the requested list." }, 502, cors);
      }
      if (!Array.isArray(action === "list" ? payload?.rows : payload?.data)) {
        return reply({ error: "Unexpected ERP response format." }, 502, cors);
      }
      return reply(payload, 200, cors);
    } catch (error) {
      return reply({ error: error?.name === "AbortError" ? "ERP loading timed out." : "Barcode loading proxy failed." },
        error?.name === "AbortError" ? 504 : 502, cors);
    } finally { clearTimeout(timer); }
  }
};
