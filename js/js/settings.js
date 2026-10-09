"use strict";

/* Settings and cookie persistence */

function readSavedSettings() {
  try {
    const raw = localStorage.getItem(CONFIG.settingsStorageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    const quantityEntryMode = String(parsed?.quantityEntryMode || "").trim().toLowerCase();
    return {
      shopKey: parsed?.shopKey || "",
      login: parsed?.login || "",
      password: parsed?.password || "",
      displayMode: "full",
      quantityEntryUnlocked: quantityEntryMode === "unlocked"
    };
  } catch {
    return { shopKey: "", login: "", password: "", displayMode: "full", quantityEntryUnlocked: false };
  }
}


function saveSettings(values, options) {
  const quantityEntryUnlocked = Boolean(values?.quantityEntryUnlocked);
  const normalizedValues = {
    shopKey: values?.shopKey || "",
    login: values?.login || "",
    password: values?.password || "",
    displayMode: "full",
    quantityEntryMode: quantityEntryUnlocked ? "unlocked" : "locked"
  };
  localStorage.setItem(CONFIG.settingsStorageKey, JSON.stringify(normalizedValues));
  if (options?.silent) {
    return;
  }
  state.els.settingsSaveNote.textContent = "Saved successfully on this device.";
  setStatus("Settings saved");
}


function fillSettingsForm(values) {
  state.els.shopKeyInput.value = values.shopKey || "";
  state.els.loginInput.value = values.login || "";
  state.els.passwordInput.value = values.password || "";
}


function renderCookieState() {
  // Cookie state is kept in storage and surfaced through the top status text only.
}


function readSavedCameraId() {
  return localStorage.getItem(CONFIG.cameraStorageKey) || "";
}


function saveCameraId(deviceId) {
  if (!deviceId) return;
  localStorage.setItem(CONFIG.cameraStorageKey, deviceId);
}


function loadCookieState() {
  state.authCookie = localStorage.getItem(CONFIG.cookieStorageKey) || "";
  state.authStatus = localStorage.getItem(CONFIG.cookieStatusStorageKey) || "No cookie saved yet.";
}


function saveCookieState(cookie, status) {
  state.authCookie = cookie || "";
  state.authStatus = status || "";
  localStorage.setItem(CONFIG.cookieStorageKey, state.authCookie);
  localStorage.setItem(CONFIG.cookieStatusStorageKey, state.authStatus);
  renderCookieState();
}


function extractCookieFromResponse(payload) {
  if (!payload) return "";

  let rawCookie = "";

  if (typeof payload === "object" && payload !== null) {
    rawCookie =
      payload.fullCookie ||
      payload.data?.fullCookie ||
      payload.cookieString ||
      payload.data?.cookieString ||
      payload.cookie ||
      payload.data?.cookie ||
      "";

    if (!rawCookie) {
      const queue = [payload];
      while (queue.length > 0 && !rawCookie) {
        const item = queue.shift();
        if (!item || typeof item !== "object") {
          continue;
        }

        const values = Object.values(item);
        for (let index = 0; index < values.length; index += 1) {
          const value = values[index];
          if (typeof value === "string" && /SESSION=|rememberMe=/i.test(value)) {
            rawCookie = value;
            break;
          }
          if (value && typeof value === "object") {
            queue.push(value);
          }
        }
      }
    }
  } else {
    rawCookie = String(payload);
  }

  if (!rawCookie) return "";

  const sessionMatch = rawCookie.match(/SESSION=([^;,\r\n]+)/i);
  const rememberMatches = [...rawCookie.matchAll(/rememberMe=([^;,\r\n]+)/gi)];
  let rememberValue = "";

  for (let index = 0; index < rememberMatches.length; index += 1) {
    const candidate = rememberMatches[index]?.[1] || "";
    if (candidate && candidate !== "deleteMe") {
      rememberValue = candidate;
    }
  }

  const cookieParts = [];
  if (sessionMatch?.[1]) {
    cookieParts.push(`SESSION=${sessionMatch[1]}`);
  }
  if (rememberValue) {
    cookieParts.push(`rememberMe=${rememberValue}`);
  }

  return cookieParts.join("; ");
}


async function loginAndRefreshCookie(settingsOverride) {
  const settings = settingsOverride || readSavedSettings();
  const shopKey = (settings.shopKey || "").trim();
  const login = (settings.login || "").trim();
  const password = settings.password || "";
  const targetSite = "lgerp.cc";

  if (!shopKey || !login || !password) {
    const message = "Fill shop key, login, and password first.";
    state.els.settingsSaveNote.textContent = message;
    saveCookieState(state.authCookie, message);
    setStatus(message);
    return "";
  }

  const params = new URLSearchParams();
  params.set("shopkey", shopKey);
  params.set("login_name", login);
  params.set("password", password);

  state.els.settingsSaveNote.textContent = `Sending login request for ${login} on ${targetSite}...`;
  saveCookieState(state.authCookie, `Refreshing cookie for ${login} on ${targetSite}...`);
  setStatus("Requesting new cookie...");

  const response = await apiFetch(CONFIG.cookieProxyEndpoint, {
    method: "POST",
    body: params.toString(),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  if (!response.ok) {
    throw new Error(`Proxy request failed with status ${response.status}`);
  }

  const responseText = await response.text();
  let parsed = responseText;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    // Keep plain text fallback.
  }

  const cookie = extractCookieFromResponse(parsed);
  if (!cookie) {
    throw new Error("Proxy answered, but no usable cookie was returned.");
  }

  saveCookieState(cookie, `Cookie refreshed successfully for ${login} on ${targetSite}.`);
  state.els.settingsSaveNote.textContent = "Login completed and cookie saved.";
  setStatus("Cookie refreshed");
  return cookie;
}

function saveScrollLockState(isLocked, position) {
  const payload = {
    isLocked: Boolean(isLocked),
    position: Number(position) || 0
  };
  localStorage.setItem(CONFIG.scrollLockStorageKey, JSON.stringify(payload));
}


function loadScrollLockState() {
  try {
    const raw = localStorage.getItem(CONFIG.scrollLockStorageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      return {
        isLocked: Boolean(parsed.isLocked),
        position: Number(parsed.position) || 0
      };
    }
    // Fallback in case an older version stored a plain "true"/"false" string.
    return { isLocked: raw === "true", position: 0 };
  } catch {
    return { isLocked: false, position: 0 };
  }
}
