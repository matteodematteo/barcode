"use strict";

/* API and proxy network requests */

// Product, discount, and sales lookups can start together. Share one cookie
// refresh promise so a missing session does not trigger duplicate login calls.
let cookieRequestPromise = null;

async function apiFetch(url, options, loaderOptions) {
  const trackLoader = loaderOptions?.trackLoader !== false;
  if (trackLoader) {
    showApiLoader();
  }
  try {
    return await fetch(url, options);
  } finally {
    if (trackLoader) {
      hideApiLoader();
    }
  }
}


async function fetchProductInfoThroughProxy(code, cookie, options) {
  const response = await apiFetch(CONFIG.infoProxyEndpoint, {
    method: "POST",
    signal: options?.signal,
    body: JSON.stringify({
      barcode: code,
      cookie: cookie
    }),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const error = new Error(`Info proxy request failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.text();
}


async function fetchDiscountInfoThroughProxy(code, cookie) {
  const response = await apiFetch(CONFIG.discountProxyEndpoint, {
    method: "POST",
    body: JSON.stringify({
      barcode: code,
      cookie: cookie
    }),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json"
    }
  }, { trackLoader: false });

  if (!response.ok) {
    throw new Error(`Discount proxy request failed with status ${response.status}`);
  }

  return response.text();
}


function getPreservedUpdateFields(product) {
  // The ERP update replaces these fields, so never omit unread values.
  const firstDiscount = product?.p_discount !== undefined
    ? product.p_discount : product?.p_discount1;
  const preserved = {
    p_discount: firstDiscount,
    p_discount2: product?.p_discount2,
    p_discount3: product?.p_discount3,
    p_discount4: product?.p_discount4,
    spec: product?.spec
  };
  const missing = Object.keys(preserved).filter((key) => preserved[key] === undefined);
  if (missing.length) {
    throw new Error(`Cannot safely update: product info is missing ${missing.join(", ")}. Reload product info and try again.`);
  }
  // Preserve the numbered alias too when supplied by the product endpoint.
  if (product.p_discount1 !== undefined) preserved.p_discount1 = product.p_discount1;
  for (const key of Object.keys(preserved)) {
    if (preserved[key] === null) preserved[key] = "";
  }
  return preserved;
}


async function fetchUpdateItemThroughProxy(payload, cookie, existingProduct) {
  const preserved = getPreservedUpdateFields(existingProduct);
  const response = await apiFetch(CONFIG.updateProxyEndpoint, {
    method: "POST",
    body: JSON.stringify({
      ...preserved,
      id: payload.id,
      barcode: payload.barcode,
      goods_code: payload.barcode,
      italian_name: payload.italian_name,
      p_price: payload.p_price,
      s_price: payload.s_price,
      s_discount: payload.s_discount,
      cookie: cookie
    }),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Update proxy request failed with status ${response.status}`);
  }

  return response.text();
}


async function fetchAddProductThroughProxy(payload, cookie) {
  const response = await apiFetch(CONFIG.addProductProxyEndpoint, {
    method: "POST",
    body: JSON.stringify({
      barcode: payload.barcode,
      italian_name: payload.italian_name,
      p_price: payload.p_price,
      s_price: payload.s_price,
      s_discount: payload.s_discount,
      cookie: cookie
    }),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Add product proxy request failed with status ${response.status}`);
  }

  return response.text();
}


async function refreshCookieForRequests(failedCookie) {
  if (cookieRequestPromise) return cookieRequestPromise;
  if (failedCookie && state.authCookie && state.authCookie !== failedCookie) {
    return state.authCookie;
  }
  cookieRequestPromise = loginAndRefreshCookie().then(function (cookie) {
    if (!cookie) throw new Error("Could not refresh login. Check your saved login settings.");
    return cookie;
  }).finally(function () { cookieRequestPromise = null; });
  return cookieRequestPromise;
}


async function getCookieForRequests() {
  if (cookieRequestPromise) return cookieRequestPromise;
  return state.authCookie || refreshCookieForRequests();
}


async function loadProductInfoResponse(barcode, onCookie, options) {
  const code = String(barcode || "").trim();
  if (!code) throw new Error("Barcode is empty");
  let cookie = options?.cookie || await getCookieForRequests();
  const maxAttempts = options?.retry === false ? 1 : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (onCookie) onCookie(cookie);
    try {
      const responseText = await fetchProductInfoThroughProxy(code, cookie, options);
      let raw;
      try { raw = JSON.parse(responseText); }
      catch { throw new Error("Product info response was not valid JSON."); }
      const normalized = normalizeProductData(raw?.product || raw);
      if (hasProductInDatabase(normalized, code) || attempt === maxAttempts - 1 || options?.retryMissing === false) {
        return { cookie, raw, normalized };
      }
    } catch (error) {
      if (attempt === maxAttempts - 1 || error?.name === "AbortError" ||
          error?.name === "TypeError" || (error?.status && error.status !== 401 && error.status !== 403) ||
          (typeof navigator !== "undefined" && navigator.onLine === false)) throw error;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error("Offline — cannot retry product lookup.");
    }
    setStatus("Refreshing login and retrying barcode...");
    cookie = await refreshCookieForRequests(cookie);
  }
}


function loadOptionalDiscount(code, cookie) {
  return fetchDiscountInfoThroughProxy(code, cookie).then(function (text) {
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }).catch(function () { return null; });
}


async function loadProductAndDiscountResponse(barcode, options = {}) {
  const code = String(barcode || "").trim();
  if (!code) {
    throw new Error("Barcode is empty");
  }

  let discountPromise;
  const info = await loadProductInfoResponse(code, function (cookie) {
    discountPromise = loadOptionalDiscount(code, cookie);
  }, { cookie: options.cookie, retry: options.retry });
  const cookie = info.cookie;
  const parsedProduct = info.raw;
  const parsedDiscount = await discountPromise;

  const normalizedProduct = normalizeProductData(parsedProduct?.product || parsedProduct);
  const discountFields = getLegacyDiscountFields({
    product: parsedProduct?.product || parsedProduct,
    sale: parsedDiscount
  }, normalizedProduct);
  const hasVisibleDiscount = discountFields.hasDiscount;

  return {
    cookie: cookie,
    product: normalizedProduct,
    sale: parsedDiscount,
    saleDiscount: discountFields.saleDiscount,
    discountPrice: hasVisibleDiscount ? discountFields.discountPrice : "",
    hasDiscount: hasVisibleDiscount
  };
}
