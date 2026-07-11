/* =====================================================
   TrustLens Live – Service Worker (Manifest V3)
   FINAL Production Version v3.5
   Deterministic • Safe • Concurrency Hardened
   ===================================================== */

/* ===============================
   CONFIG
   =============================== */

const MANIFEST = chrome.runtime.getManifest();
const VERSION = MANIFEST.version;

const CONFIG = {
  VERIFY_ENDPOINT: "https://trustlens-api.onrender.com/verify",
  BATCH_ENDPOINT: "https://trustlens-api.onrender.com/verify-batch",
  TIMEOUT: 10000,
  MAX_RETRIES: 2,
  CACHE_TTL: 60 * 60 * 1000,
  MAX_CACHE_ITEMS: 100,
  MAX_HISTORY: 50,
  BADGE_DURATION: 30000,
  RATE_LIMIT_WINDOW: 60000,
  RATE_LIMIT_MAX: 10,
  MAX_TEXT_LENGTH: 2000
};

/* ===============================
   STATE (Worker-Safe)
   =============================== */

const pendingRequests = new Map();      // textHash -> Promise
const badgeTimers = new Map();         // tabId -> timeout
const rateLimiter = new Map();         // tabId -> timestamps array

/* =====================================================
   INSTALLATION
   ===================================================== */

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: "trustlens-verify",
    title: "🔍 Verify with TrustLens",
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TEXT_SELECTED") {
    handleVerification(msg.text, sender.tab?.id)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

/* =====================================================
   MAIN VERIFICATION ENTRY
   ===================================================== */

async function handleVerification(rawText, tabId) {
  if (!tabId || !rawText) throw new Error("Invalid request");

  if (isRateLimited(tabId)) {
    notifyTab(tabId, "RATE_LIMIT_NOTICE", {
      message: "Too many verification requests. Please wait."
    });
    throw new Error("Rate limit exceeded");
  }

  const text = sanitizeText(rawText);
  const key = fingerprint(text);

  if (pendingRequests.has(key)) {
    return pendingRequests.get(key);
  }

  const promise = executeVerification(text, tabId)
    .finally(() => pendingRequests.delete(key));

  pendingRequests.set(key, promise);
  return promise;
}

/* =====================================================
   EXECUTION PIPELINE
   ===================================================== */

async function executeVerification(text, tabId) {
  try {
    notifyTab(tabId, "VERIFICATION_STARTED");

    const cached = await getCached(text);
    if (cached) {
      notifyTab(tabId, "SHOW_TRUST_RESULT", cached);
      return cached;
    }

    const result = await fetchWithRetry(text);
    const normalized = normalizeResult(result, text);

    await storeCache(text, normalized);
    await storeHistory(normalized, text);
    updateBadge(tabId, normalized.score);

    notifyTab(tabId, "SHOW_TRUST_RESULT", normalized);

    return normalized;

  } catch (err) {
    const fallback = buildFallback(text);
    notifyTab(tabId, "VERIFICATION_ERROR", { error: err.message });
    notifyTab(tabId, "SHOW_TRUST_RESULT", fallback);
    return fallback;
  }
}

/* =====================================================
   FETCH + RETRY
   ===================================================== */

async function fetchWithRetry(text) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES + 1; attempt++) {
    try {
      return await fetchWithTimeout(text);
    } catch (err) {
      lastError = err;
      if (attempt <= CONFIG.MAX_RETRIES) {
        await delay(1000 * attempt);
      }
    }
  }

  throw lastError;
}

async function fetchWithTimeout(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);

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

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  return res.json();
}

/* =====================================================
   CACHE (Storage-Backed)
   ===================================================== */

async function getCached(text) {
  const hash = fingerprint(text);
  const { cache = {} } = await chrome.storage.local.get("cache");

  const entry = cache[hash];
  if (!entry) return null;

  if (Date.now() - entry.timestamp > CONFIG.CACHE_TTL) {
    delete cache[hash];
    await chrome.storage.local.set({ cache });
    return null;
  }

  return entry.result;
}

async function storeCache(text, result) {
  const hash = fingerprint(text);
  const { cache = {} } = await chrome.storage.local.get("cache");

  cache[hash] = {
    result,
    timestamp: Date.now()
  };

  const keys = Object.keys(cache);
  if (keys.length > CONFIG.MAX_CACHE_ITEMS) {
    keys
      .sort((a, b) => cache[a].timestamp - cache[b].timestamp)
      .slice(0, keys.length - CONFIG.MAX_CACHE_ITEMS)
      .forEach(k => delete cache[k]);
  }

  await chrome.storage.local.set({ cache });
}

/* =====================================================
   HISTORY
   ===================================================== */

async function storeHistory(result, text) {
  const { history = [] } = await chrome.storage.local.get("history");

  const item = {
    id: crypto.randomUUID(),
    text: text.slice(0, 120),
    score: result.score,
    verdict: result.verdict,
    timestamp: Date.now()
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
  const color =
    score >= 70 ? "#4CAF50" :
    score >= 40 ? "#FF9800" :
    "#F44336";

  chrome.action.setBadgeText({ tabId, text: String(score) });
  chrome.action.setBadgeBackgroundColor({ tabId, color });

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
   RATE LIMIT (Sliding Window)
   ===================================================== */

function isRateLimited(tabId) {
  const now = Date.now();
  const history = rateLimiter.get(tabId) || [];

  const recent = history.filter(t => now - t < CONFIG.RATE_LIMIT_WINDOW);

  if (recent.length >= CONFIG.RATE_LIMIT_MAX) {
    rateLimiter.set(tabId, recent);
    return true;
  }

  recent.push(now);
  rateLimiter.set(tabId, recent);
  return false;
}

/* =====================================================
   HELPERS
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

function buildFallback(text) {
  return {
    score: 50,
    verdict: "Unverifiable",
    explanation: "Verification unavailable. Offline fallback used.",
    confidence: 50,
    fallback: true,
    timestamp: Date.now()
  };
}

function notifyTab(tabId, type, payload = {}) {
  chrome.tabs.sendMessage(tabId, {
    type,
    result: payload
  }).catch(() => {});
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}

/* =====================================================
   CLEANUP
   ===================================================== */

chrome.tabs.onRemoved.addListener(tabId => {
  rateLimiter.delete(tabId);

  if (badgeTimers.has(tabId)) {
    clearTimeout(badgeTimers.get(tabId));
    badgeTimers.delete(tabId);
  }
});
