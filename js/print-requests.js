"use strict";

/* Successful TXT and label sends saved on this device for later viewing/printing. */
const MAX_PRINT_REQUESTS = 20;

function loadPrintTunnelPreference() {
  let tunnelId = "gate1";
  try {
    const saved = localStorage.getItem(CONFIG.printTunnelStorageKey);
    if (["gate1", "gate2"].includes(saved)) tunnelId = saved;
  } catch {
    // Keep Gate 1 when storage is unavailable.
  }
  state.els.printTunnelSelect.value = tunnelId;
  state.els.printRequestTunnelSelect.value = tunnelId;
}

function savePrintTunnelPreference(tunnelId) {
  if (!["gate1", "gate2"].includes(tunnelId)) return;
  state.els.printTunnelSelect.value = tunnelId;
  state.els.printRequestTunnelSelect.value = tunnelId;
  try {
    localStorage.setItem(CONFIG.printTunnelStorageKey, tunnelId);
  } catch {
    // The selected gate still works for this session.
  }
}

function copyPrintRequestItem(item) {
  const row = normalizeHistoryItem(item);
  return {
    barcode: row.barcode,
    italian_name: row.italian_name,
    comparison_qty: row.comparison_qty,
    s_price: row.s_price,
    s_discount: row.s_discount,
    discount_price: row.discount_price,
    has_discount: row.has_discount
  };
}

function normalizePrintRequest(value) {
  if (!value || !["TXT", "60*38", "40*25"].includes(value.type) || !Array.isArray(value.items)) return null;
  const items = value.items.map(copyPrintRequestItem).filter((item) => item.barcode);
  if (!items.length) return null;
  return {
    id: String(value.id || ""),
    type: value.type,
    sentAt: String(value.sentAt || ""),
    tunnelId: ["gate1", "gate2"].includes(value.tunnelId) ? value.tunnelId : "",
    timestamp: Boolean(value.timestamp),
    items
  };
}

function loadPrintRequestHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG.printRequestStorageKey) || "[]");
    state.printRequests = Array.isArray(saved)
      ? saved.map(normalizePrintRequest).filter(Boolean).slice(0, MAX_PRINT_REQUESTS)
      : [];
  } catch {
    state.printRequests = [];
  }
}

function recordSentPrintRequest(type, items, timestamp, tunnelId) {
  const entry = normalizePrintRequest({
    id: `print_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type, sentAt: new Date().toISOString(), tunnelId, timestamp, items
  });
  if (!entry) return false;
  state.printRequests.unshift(entry);
  state.printRequests.length = Math.min(state.printRequests.length, MAX_PRINT_REQUESTS);
  renderPrintRequestHistory();
  state.els.printBtn.disabled = false;
  try {
    localStorage.setItem(CONFIG.printRequestStorageKey, JSON.stringify(state.printRequests));
    return true;
  } catch {
    return false;
  }
}

function printRequestTypeLabel(type) {
  return type === "60*38" ? "BIG 60*38" : type === "40*25" ? "STICKER 40*25" : "TXT";
}

function formatPrintRequestDate(iso) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "Previous request";
}

function renderPrintRequestHistory() {
  const container = state.els?.printRequestHistoryList;
  if (!container) return;
  if (!state.printRequests.length) {
    const empty = document.createElement("p");
    empty.className = "print-request-empty";
    empty.textContent = "No sent requests yet.";
    container.replaceChildren(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of state.printRequests) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "print-request-row";
    button.dataset.printRequestId = entry.id;
    const heading = document.createElement("strong");
    heading.textContent = `${printRequestTypeLabel(entry.type)} · ${entry.items.length} barcode${entry.items.length === 1 ? "" : "s"}`;
    const meta = document.createElement("span");
    meta.textContent = `${formatPrintRequestDate(entry.sentAt)}${entry.tunnelId ? ` · ${entry.tunnelId === "gate1" ? "Gate 1" : "Gate 2"}` : ""}`;
    button.append(heading, meta);
    fragment.appendChild(button);
  }
  container.replaceChildren(fragment);
}

function printRequestDisplayPrice(entry, item) {
  const sent = entry.type === "TXT" ? buildHistoryPayloadItem(item) : buildDirectPrintPayloadItem(item);
  const original = numberFromValue(sent.s_price);
  const discounted = numberFromValue(sent.discount_price);
  const actual = entry.type !== "TXT" && discounted > 0 && discounted < original ? discounted : original;
  return actual ? `EUR ${formatPrice(actual)}` : "EUR -";
}

function openPrintRequestDetail(id) {
  const entry = state.printRequests.find((item) => item.id === id);
  if (!entry) return;
  state.activePrintRequestId = id;
  closePrintDialog();
  state.els.printRequestDetailTitle.textContent = printRequestTypeLabel(entry.type);
  state.els.printRequestDetailMeta.textContent = `${formatPrintRequestDate(entry.sentAt)} · ${entry.items.length} barcode${entry.items.length === 1 ? "" : "s"}${entry.tunnelId ? ` · ${entry.tunnelId === "gate1" ? "Gate 1" : "Gate 2"}` : ""}`;
  state.els.printRequestTunnelSelect.value = state.els.printTunnelSelect.value || "gate1";
  state.els.printRequestTimestampCheckbox.checked = true;
  state.els.printRequestDetailStatus.textContent = "";
  const fragment = document.createDocumentFragment();
  for (const item of entry.items) {
    const row = document.createElement("article");
    row.className = "print-request-item";
    const top = document.createElement("div");
    top.className = "print-request-item-top";
    const barcode = document.createElement("strong");
    barcode.textContent = item.barcode;
    const quantity = document.createElement("span");
    quantity.textContent = `Qty ${item.comparison_qty}`;
    top.append(barcode, quantity);
    const name = document.createElement("div");
    name.className = "print-request-item-name";
    name.textContent = item.italian_name || "No name loaded";
    const price = document.createElement("div");
    price.className = "print-request-item-price";
    price.textContent = `Price: ${printRequestDisplayPrice(entry, item)}`;
    row.append(top, name, price);
    fragment.appendChild(row);
  }
  state.els.printRequestDetailItems.replaceChildren(fragment);
  state.els.printRequestDetailDialog.classList.add("is-open");
  state.els.printRequestDetailDialog.setAttribute("aria-hidden", "false");
  state.els.printRequestCancelBtn.focus({ preventScroll: true });
}

function closePrintRequestDetail(returnToPrint = true) {
  if (state.isPrintRequestSending) return;
  state.activePrintRequestId = "";
  state.els.printRequestDetailDialog.classList.remove("is-open");
  state.els.printRequestDetailDialog.setAttribute("aria-hidden", "true");
  if (returnToPrint) openPrintDialog();
}

function setSavedPrintButtonsDisabled(disabled) {
  for (const button of [state.els.printRequestTxtBtn, state.els.printRequestBigBtn,
    state.els.printRequestStickerBtn, state.els.printRequestCancelBtn]) {
    button.disabled = disabled;
  }
}

async function sendSavedPrintRequest(type, confirmedSignature) {
  if (state.isPrintRequestSending) return;
  const entry = state.printRequests.find((item) => item.id === state.activePrintRequestId);
  if (!entry) return;
  const tunnelId = state.els.printRequestTunnelSelect.value;
  if (type !== "TXT" && !["gate1", "gate2"].includes(tunnelId)) {
    state.els.printRequestDetailStatus.textContent = "Choose Gate 1 or Gate 2 before printing.";
    return;
  }
  const payload = {
    session_id: type === "TXT" ? formatSessionId() : `directPrint_${type}_${formatTimestamp()}`,
    session_cost: type === "TXT" ? "$0.00" : "$1.00",
    ...(type === "TXT" ? {} : { print_type: type, tunnel_id: tunnelId }),
    timestamp: state.els.printRequestTimestampCheckbox.checked,
    data: [{
      stack: type === "TXT" ? "full_tickets" : type === "40*25" ? "sticker_tickets" : "big_tickets",
      items: entry.items.map(type === "TXT" ? buildHistoryPayloadItem : buildDirectPrintPayloadItem)
    }]
  };
  if (type !== "TXT") {
    const problems = [];
    entry.items.forEach((item, index) => {
      const reasons = [];
      if (numberFromValue(item.s_price) <= 0) reasons.push("price missing or 0.00");
      if (!String(item.italian_name || "").trim()) reasons.push("name missing");
      if (reasons.length) problems.push(`Record ${index + 1} (${item.barcode}): ${reasons.join(", ")}`);
    });
    const signature = JSON.stringify([entry.id, tunnelId, type, payload.timestamp, payload.data]);
    if (problems.length && confirmedSignature !== signature) {
      openConfirmDialog(
        problems.join("\n") + `\n\nPrint all records to ${tunnelId} (${type}) anyway?`,
        () => sendSavedPrintRequest(type, signature)
      );
      state.els.confirmDialogCancelBtn.focus({ preventScroll: true });
      return;
    }
  }
  state.isPrintRequestSending = true;
  setSavedPrintButtonsDisabled(true);
  state.els.printRequestDetailStatus.textContent = `Sending ${printRequestTypeLabel(type)}...`;
  try {
    const response = await apiFetch(CONFIG.sendTxtEndpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const details = (await response.text()).trim();
      throw new Error(details || `Send failed with status ${response.status}`);
    }
    const saved = recordSentPrintRequest(type, entry.items, payload.timestamp, type === "TXT" ? "" : tunnelId);
    state.isPrintRequestSending = false;
    closePrintRequestDetail();
    setStatus(saved ? `${printRequestTypeLabel(type)} sent successfully` : `${printRequestTypeLabel(type)} sent; recent request could not be saved on this device`);
  } catch (error) {
    const message = error.message || "Print request failed";
    state.els.printRequestDetailStatus.textContent = message;
    setStatus(message);
  } finally {
    state.isPrintRequestSending = false;
    setSavedPrintButtonsDisabled(false);
  }
}
