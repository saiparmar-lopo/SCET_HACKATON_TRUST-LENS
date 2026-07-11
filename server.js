/* =====================================================
   TrustLens Live – Service Worker v3.0
   Deterministic • Hardened • Production Grade
   ===================================================== */

const MANIFEST = chrome.runtime.getManifest();
const VERSION = MANIFEST.version;

/* ===============================
   CONFIG
   =============================== */

const CONFIG = {
  VERIFY_ENDPOINT: "https://trustlens-api.onrender.com/verify",
  TIMEOUT_MS: 10000,
  BADGE_DURATION: 30000,
  MAX_HISTORY: 50,
  MAX_TEXT_LENGTH: 2000,
  RETRY_ATTEMPTS: 1
};

/* ===============================
   State
   =============================== */

const pendingRequests = new Map(); // key -> Promise
const badgeTimers = new Map();     // tabId -> timeoutId

/* =====================================================
   INSTALL
   ===================================================== */

chrome.runtime.onInstalled.addListener(details => {
  chrome.contextMenus.create({
    id: "trustlens-verify",
    title: "Verify with TrustLens",
    contexts: ["selection"]
  });

  if (details.reason === "install") {
    chrome.tabs.create({
      url: chrome.runtime.getURL("welcome.html")
    });
  }
});

/* =====================================================
   MESSAGE HANDLER
   ===================================================== */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== "TEXT_SELECTED") return;

  const tabId = sender.tab?.id;
  if (!tabId || !msg.text) return;

  verifyText(msg.text, tabId, {});
});

/* =====================================================
   CORE VERIFY
   ===================================================== */

async function verifyText(rawText, tabId, options = {}) {
  const text = sanitizeText(rawText);

  if (!text) return;

  const key = fingerprint(text);

  if (pendingRequests.has(key)) {
    return pendingRequests.get(key);
  }

  const requestPromise = executeVerification(text, tabId, options)
    .finally(() => pendingRequests.delete(key));

  pendingRequests.set(key, requestPromise);
  return requestPromise;
}

async function executeVerification(text, tabId, options) {
  try {
    notifyTab(tabId, "VERIFICATION_STARTED");

    const result = await fetchWithRetry(text);

    const normalized = normalizeResult(result, text);

    notifyTab(tabId, "SHOW_TRUST_RESULT", normalized);
    chrome.runtime.sendMessage({
      type: "SHOW_TRUST_RESULT",
      result: normalized
    }).catch(() => {});

    await persistHistory(normalized, text, tabId);
    updateBadge(tabId, normalized.score);

    return normalized;

  } catch (err) {
    const fallback = buildFallback(text, err);
    notifyTab(tabId, "VERIFICATION_ERROR", err.message);
    return fallback;
  }
}

/* =====================================================
   FETCH WITH TIMEOUT + RETRY
   ===================================================== */

async function fetchWithRetry(text) {
  let attempt = 0;
  let lastError;

  while (attempt <= CONFIG.RETRY_ATTEMPTS) {
    try {
      return await fetchWithTimeout(text);
    } catch (err) {
      lastError = err;
      attempt++;
    }
  }

  throw lastError;
}

async function fetchWithTimeout(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);

  const res = await fetch(CONFIG.VERIFY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Extension-Version": VERSION
    },
    body: JSON.stringify({ text }),
    signal: controller.signal
  });

  clearTimeout(timeout);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.json();
}

/* =====================================================
   HISTORY
   ===================================================== */

async function persistHistory(result, text, tabId) {
  const { history = [] } = await chrome.storage.local.get("history");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const item = {
    id: crypto.randomUUID(),
    text: text.slice(0, 120),
    score: result.score,
    verdict: result.verdict,
    timestamp: Date.now(),
    url: tab?.url || null
  };

  history.unshift(item);

  await chrome.storage.local.set({
    history: history.slice(0, CONFIG.MAX_HISTORY),
    latestResult: result
  });
}

/* =====================================================
   BADGE
   ===================================================== */

function updateBadge(tabId, score) {
  if (!tabId) return;

  const color =
    score >= 70 ? "#4CAF50" :
    score >= 40 ? "#FF9800" :
    "#F44336";

  chrome.action.setBadgeText({
    tabId,
    text: String(score)
  });

  chrome.action.setBadgeBackgroundColor({
    tabId,
    color
  });

  if (badgeTimers.has(tabId)) {
    clearTimeout(badgeTimers.get(tabId));
  }

  const timer = setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" });
    badgeTimers.delete(tabId);
  }, CONFIG.BADGE_DURATION);

  badgeTimers.set(tabId, timer);
}

/* =====================================================
   NORMALIZATION
   ===================================================== */

function normalizeResult(result, text) {
  const score = Number(result.score) || 50;

  return {
    score: clamp(score, 0, 100),
    verdict: result.verdict || "Unverifiable",
    explanation: result.explanation || "Analysis completed.",
    confidence: result.confidence || 70,
    timestamp: Date.now(),
    version: VERSION
  };
}

function buildFallback(text, err) {
  return {
    score: 50,
    verdict: "Unverifiable",
    explanation: "Verification failed. Offline fallback used.",
    confidence: 50,
    fallback: true,
    timestamp: Date.now()
  };
}

/* =====================================================
   UTILITIES
   ===================================================== */

function sanitizeText(text) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CONFIG.MAX_TEXT_LENGTH);
}

function fingerprint(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString();
}

function notifyTab(tabId, type, payload = {}) {
  chrome.tabs.sendMessage(tabId, {
    type,
    result: payload
  }).catch(() => {});
}

function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}

/* =====================================================
   CLEANUP
   ===================================================== */

chrome.tabs.onRemoved.addListener(tabId => {
  pendingRequests.clear();
  if (badgeTimers.has(tabId)) {
    clearTimeout(badgeTimers.get(tabId));
    badgeTimers.delete(tabId);
  }
});
