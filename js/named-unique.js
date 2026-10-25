"use strict";

/* Named TXT export: one item per exact, trimmed barcode. */
let namedUniqueSource = null;
let namedUniqueAccepted = false;

function normalizeNamedUniqueFileName(value) {
  let name = String(value ?? "").trim();
  name = name.replace(/\.txt$/i, "").replace(/[\s.]+$/g, "");
  if (!name || name.length > 120 || /[\x00-\x1f\\/:*?"<>|]/.test(name)) return null;
  return `${name}.txt`;
}

function uniqueByBarcode(items) {
  const grouped = new Map();
  for (const item of items) {
    const barcode = String(item?.barcode ?? "").trim();
    if (!barcode) throw new Error("A barcode is missing. Check the list before sending.");
    const rawQuantity = Number(item.comparison_qty);
    if (!Number.isSafeInteger(rawQuantity)) throw new Error("A quantity is invalid. Check the list before sending.");
    const quantity = Math.max(1, rawQuantity);
    const previous = grouped.get(barcode);
    const total = (previous?.comparison_qty || 0) + quantity;
    if (total > 2147483647) throw new Error(`Quantity is too large for barcode ${barcode}.`);
    grouped.set(barcode, previous ? { ...previous, comparison_qty: total } :
      { ...item, barcode, comparison_qty: total });
  }
  return [...grouped.values()];
}

function buildNamedUniquePayloadItem(item) {
  const price = numberFromValue(item.s_price);
  const savedDiscountPrice = numberFromValue(item.discount_price);
  const effectivePrice = price > 0 ? price : savedDiscountPrice > 0 ? savedDiscountPrice : 0;
  const discount = normalizeSaleDiscountPercent(item.s_discount);
  const discountPrice = savedDiscountPrice > 0 ? savedDiscountPrice :
    effectivePrice > 0 && discount > 0 ? effectivePrice * (1 - discount / 100) : 0;
  const barcode = String(item.barcode).trim();
  const italianName = String(item.italian_name || "").trim() ||
    String(item.notes || "").trim() || String(item.display_value || "").trim() || barcode;
  return {
    barcode,
    italian_name: italianName,
    comparison_qty: item.comparison_qty,
    s_price: effectivePrice.toFixed(2),
    ...(discount > 0 ? { s_discount: String(discount) } : {}),
    ...(discountPrice > 0 ? { discount_price: discountPrice.toFixed(2) } : {})
  };
}

function updateNamedUniqueValidation() {
  const name = normalizeNamedUniqueFileName(state.els.namedUniqueNameInput.value);
  const hasText = state.els.namedUniqueNameInput.value.trim().length > 0;
  state.els.namedUniqueNameInput.setAttribute("aria-invalid", String(hasText && !name));
  state.els.namedUniquePreview.textContent = name ? `File name: ${name}` :
    hasText ? "Use up to 120 characters; avoid \\ / : * ? \" < > |" : "";
  state.els.namedUniqueSendBtn.disabled = !name || state.isNamedUniqueSending || namedUniqueAccepted;
  return name;
}

function openNamedUniqueDialog(source, entryId = "") {
  if (state.isNamedUniqueSending || state.els.namedUniqueDialog.classList.contains("is-open")) return;
  if (state.isWorkerSending) { setStatus("Another send is in progress."); return; }
  const entry = source === "saved" ? state.printRequests.find(item => item.id === entryId) : null;
  if (source === "saved" ? !entry?.items?.length : !state.history.length) {
    setStatus("Barcode list is empty");
    return;
  }
  namedUniqueSource = { source, entryId };
  namedUniqueAccepted = false;
  const origin = source === "saved" ? state.els.printRequestDetailDialog : state.els.printDialog;
  origin.classList.remove("is-open");
  origin.setAttribute("aria-hidden", "true");
  state.els.namedUniqueNameInput.value = "";
  state.els.namedUniqueStatus.textContent = "";
  updateNamedUniqueValidation();
  state.els.namedUniqueDialog.classList.add("is-open");
  state.els.namedUniqueDialog.setAttribute("aria-hidden", "false");
  state.els.namedUniqueNameInput.focus({ preventScroll: true });
}

function closeNamedUniqueDialog(returnToSource = true) {
  if (state.isNamedUniqueSending || !namedUniqueSource) return;
  const source = namedUniqueSource;
  namedUniqueSource = null;
  state.els.namedUniqueDialog.classList.remove("is-open");
  state.els.namedUniqueDialog.setAttribute("aria-hidden", "true");
  if (returnToSource) {
    const origin = source.source === "saved" ? state.els.printRequestDetailDialog : state.els.printDialog;
    origin.classList.add("is-open");
    origin.setAttribute("aria-hidden", "false");
    const button = source.source === "saved" ? state.els.printRequestNamedUniqueBtn : state.els.namedUniqueBtn;
    button.focus({ preventScroll: true });
  } else {
    if (source.source === "saved") state.activePrintRequestId = "";
    moveFocusToInput(state.els.barcodeInput);
  }
}

async function sendNamedUnique() {
  if (!namedUniqueSource || state.isNamedUniqueSending || state.isWorkerSending || namedUniqueAccepted) return;
  const fileName = updateNamedUniqueValidation();
  if (!fileName) return;
  const source = namedUniqueSource;
  const sourceEntry = source.source === "saved" ? state.printRequests.find(item => item.id === source.entryId) : null;
  const originalItems = source.source === "saved" ? sourceEntry?.items : state.history;
  if (!originalItems?.length) {
    state.els.namedUniqueStatus.textContent = "The barcode list is empty.";
    return;
  }
  state.isNamedUniqueSending = true;
  state.isWorkerSending = true;
  updateNamedUniqueValidation();
  state.els.namedUniqueCancelBtn.disabled = true;
  state.els.namedUniqueStatus.textContent = "Sending…";
  try {
    // Capture the original IDs before the network call. Later scans can be
    // added safely; only these source rows are removed after archiving.
    const snapshot = originalItems.map(item => ({ ...item }));
    const sourceIds = new Set(snapshot.map(item => item.id));
    const grouped = uniqueByBarcode(snapshot);
    const payload = {
      session_id: fileName.slice(0, -4),
      session_cost: "$0.00",
      data: [{ stack: "full_tickets", items: grouped.map(buildNamedUniquePayloadItem) }]
    };
    const response = await apiFetch(CONFIG.sendTxtEndpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Named/Unique send failed with status ${response.status}.`);
    namedUniqueAccepted = true;
    if (!recordSentPrintRequest("TXT Unique", grouped, false, "", fileName)) {
      throw new Error("Sent, but recent request could not be saved. The current list was kept.");
    }
    if (source.source === "current") {
      const remaining = state.history.filter(item => !sourceIds.has(item.id));
      try { localStorage.setItem(CONFIG.historyStorageKey, JSON.stringify(remaining)); }
      catch (_) { throw new Error("Sent and saved in Recent print requests, but the current list could not be cleared."); }
      state.history = remaining;
      state.selectedHistoryIndex = remaining.length ? 0 : -1;
      renderHistory();
      if (remaining.length) revealNewestHistoryItem();
    }
    state.els.namedUniqueStatus.textContent = "";
    setStatus(`Named/Unique TXT sent as ${fileName}`);
    state.isNamedUniqueSending = false;
    closeNamedUniqueDialog(false);
  } catch (error) {
    state.els.namedUniqueStatus.textContent = error.message || "Could not send Named/Unique TXT.";
    setStatus(state.els.namedUniqueStatus.textContent);
  } finally {
    state.isNamedUniqueSending = false;
    state.isWorkerSending = false;
    state.els.namedUniqueCancelBtn.disabled = false;
    updateNamedUniqueValidation();
  }
}
