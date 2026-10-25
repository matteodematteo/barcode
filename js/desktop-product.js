"use strict";

// Reuse the actual fields in both layouts, preserving their mobile positions.
const desktopProductDetails = (() => {
  const definitions = [
    ["italian_name", "name", "Italian name"],
    ["spec", "spec-stock", "Spec"],
    ["real_inventory", "spec-stock", "Inventory"],
    ["p_price", "supplier-cost", "Cost", true],
    ["supplier_name", "supplier-cost", "Supplier"],
    ["discount_percent", "costs", "Cost Discounts"],
    ["disc_cost", "costs", "Net Cost", true],
    ["disc_iva", "costs", "+IVA 22%", true],
    ["s_price", "selling", "Price", true],
    ["disc_price_percent", "selling", "Discount"],
    ["discount_price", "selling", "Discounted price", true]
  ];
  let root = null, entries = [], summary = null, active = false, fitFrame = 0;
  const byKey = new Map();

  function money(value) {
    const raw = String(value ?? "");
    const numeric = Number(raw.trim().replace(",", "."));
    return raw.trim() && Number.isFinite(numeric) ? `€${numeric.toFixed(2)}` : raw;
  }

  function fit(element, maximum) {
    element.style.fontSize = `${maximum}px`;
    if (!element.clientWidth || element.scrollWidth <= element.clientWidth) return;
    let low = 0.5, high = maximum;
    for (let step = 0; step < 14; step++) {
      const size = (low + high) / 2;
      element.style.fontSize = `${size}px`;
      if (element.scrollWidth > element.clientWidth) high = size;
      else low = size;
    }
    element.style.fontSize = `${Math.max(0.5, low - 0.1)}px`;
  }

  function scheduleFit() {
    if (!active || fitFrame) return;
    fitFrame = requestAnimationFrame(function () {
      fitFrame = 0;
      if (!active) return;
      for (const entry of entries) {
        fit(entry.label, 11);
        if (entry.key !== "italian_name") fit(entry.value, entry.slotName === "selling" ? 20 : 15);
      }
    });
  }

  function fieldChanged(key) {
    const entry = byKey.get(key);
    if (!entry) return;
    entry.raw = entry.value.textContent;
    if (active && entry.currency) entry.value.textContent = money(entry.raw);
    scheduleFit();
  }

  function init() {
    if (root) return;
    root = document.getElementById("desktopProductDetails");
    if (!root) return;
    for (const [key, slotName, desktopLabel, currency] of definitions) {
      const card = document.getElementById(`field_${key}_card`);
      const value = document.getElementById(`field_${key}`);
      const label = card?.querySelector("label");
      const slot = root.querySelector(`[data-product-slot="${slotName}"]`);
      if (!card || !value || !label || !slot) continue;
      const anchor = document.createComment(`mobile ${key}`);
      card.before(anchor);
      const entry = { key, card, value, label, slotName, slot, desktopLabel, currency,
        anchor, mobileLabel: label.textContent, raw: value.textContent };
      entries.push(entry);
      byKey.set(key, entry);
    }
    const row = document.querySelector(".sales-summary-row");
    if (row) {
      const anchor = document.createComment("mobile sales summary");
      row.before(anchor);
      summary = { row, anchor, slot: root.querySelector('[data-product-slot="sales-summary"]') };
    }
    if (typeof ResizeObserver === "function") {
      let previousWidth = -1;
      const observer = new ResizeObserver(function (records) {
        const width = records[0]?.contentRect.width || 0;
        if (Math.abs(width - previousWidth) < 0.25) return;
        previousWidth = width;
        scheduleFit();
      });
      observer.observe(root);
    }
    window.addEventListener("resize", scheduleFit, { passive: true });
  }

  function setDesktop(desktop) {
    init();
    if (!root) return;
    if (desktop === active) { scheduleFit(); return; }
    active = desktop;
    for (const entry of entries) {
      if (desktop) {
        entry.raw = entry.value.textContent;
        entry.slot.append(entry.card);
        entry.label.textContent = entry.desktopLabel;
        if (entry.currency) entry.value.textContent = money(entry.raw);
      } else {
        entry.anchor.after(entry.card);
        entry.label.textContent = entry.mobileLabel;
        if (entry.currency) entry.value.textContent = entry.raw;
        entry.label.style.removeProperty("font-size");
        entry.value.style.removeProperty("font-size");
      }
    }
    if (summary) {
      if (desktop) summary.slot.append(summary.row);
      else summary.anchor.after(summary.row);
    }
    root.hidden = !desktop;
    scheduleFit();
  }

  return { init, setDesktop, fieldChanged };
})();
