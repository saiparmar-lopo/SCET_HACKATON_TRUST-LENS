/* =====================================================
   TrustLens Live – Popup Controller v3.0
   Secure • Deterministic • Accessible
   ===================================================== */

const state = {
  currentResult: null,
  settings: null,
  stats: null,
  history: [],
  currentTab: "result"
};

/* ===============================
   DOM Cache
   =============================== */

const $ = id => document.getElementById(id);

const dom = {
  statusIndicator: $("statusIndicator"),
  statusText: $("statusText"),
  syncTime: $("syncTime"),

  tabs: document.querySelectorAll('[role="tab"]'),
  tabPanels: document.querySelectorAll('[role="tabpanel"]'),

  loadingState: $("loadingState"),
  resultContent: $("resultContent"),
  emptyState: $("emptyState"),

  scoreCircle: $("scoreCircle"),
  scoreValue: $("scoreValue"),
  verdictBadge: $("verdictBadge"),
  reasonBox: $("reasonBox"),

  confidenceSection: $("confidenceSection"),
  confidenceValue: $("confidenceValue"),
  confidenceFill: $("confidenceFill"),

  analysisMethod: $("analysisMethod"),
  processingTime: $("processingTime"),

  historyList: $("historyList")
};

/* =====================================================
   INIT
   ===================================================== */

document.addEventListener("DOMContentLoaded", async () => {
  await hydrate();
  setupEvents();
  checkConnection();
});

/* =====================================================
   HYDRATE
   ===================================================== */

async function hydrate() {
  const data = await chrome.storage.local.get([
    "settings",
    "stats",
    "history",
    "latestResult"
  ]);

  state.settings = data.settings || {};
  state.stats = data.stats || {};
  state.history = data.history || [];

  if (data.latestResult) {
    renderResult(data.latestResult);
  } else {
    showEmpty();
  }

  renderHistory();
}

/* =====================================================
   RESULT RENDERING
   ===================================================== */

function renderResult(result) {
  state.currentResult = result;

  showResultState();

  const score = clamp(result.score ?? 50, 0, 100);
  const color = scoreColor(score);

  dom.scoreCircle.style.setProperty("--score", score);
  dom.scoreCircle.style.setProperty("--score-color", color);
  dom.scoreValue.textContent = score;

  dom.verdictBadge.textContent = result.verdict || "Analysis";
  dom.verdictBadge.className = `verdict-badge ${verdictClass(result.verdict)}`;

  dom.reasonBox.textContent =
    result.explanation ||
    result.claims?.[0]?.reason ||
    "No explanation available.";

  if (result.confidence != null) {
    dom.confidenceSection.classList.remove("hidden");
    dom.confidenceValue.textContent = `${result.confidence}%`;
    dom.confidenceFill.style.width = `${result.confidence}%`;
  } else {
    dom.confidenceSection.classList.add("hidden");
  }

  dom.analysisMethod.textContent =
    result.aiEnabled ? "AI + Rules" : "Rules Only";

  dom.processingTime.textContent =
    result.processingTime != null
      ? `${result.processingTime}ms`
      : "—";
}

function showResultState() {
  toggle(dom.loadingState, false);
  toggle(dom.resultContent, true);
  toggle(dom.emptyState, false);
}

function showEmpty() {
  toggle(dom.loadingState, false);
  toggle(dom.resultContent, false);
  toggle(dom.emptyState, true);
}

/* =====================================================
   HISTORY
   ===================================================== */

function renderHistory() {
  if (!dom.historyList) return;

  dom.historyList.innerHTML = "";

  if (state.history.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "No verification history yet.";
    empty.className = "empty-state";
    dom.historyList.appendChild(empty);
    return;
  }

  state.history.slice(0, 30).forEach(item => {
    const el = document.createElement("div");
    el.className = "history-item";

    const score = document.createElement("div");
    score.textContent = `${item.score}%`;
    score.className = `history-score ${verdictClass(item.verdict)}`;

    const text = document.createElement("div");
    text.textContent = item.text;
    text.className = "history-text";

    el.append(score, text);

    el.addEventListener("click", () => {
      renderResult(item);
      switchTab("result");
    });

    dom.historyList.appendChild(el);
  });
}

/* =====================================================
   TABS (Accessible)
   ===================================================== */

function setupEvents() {
  dom.tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      switchTab(tab.id.replace("tab", "").toLowerCase());
    });
  });
}

function switchTab(name) {
  state.currentTab = name;

  dom.tabs.forEach(tab => {
    const isActive = tab.id.toLowerCase().includes(name);
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", isActive);
  });

  dom.tabPanels.forEach(panel => {
    const match = panel.id.toLowerCase().includes(name);
    panel.hidden = !match;
    panel.classList.toggle("active", match);
  });
}

/* =====================================================
   CONNECTION CHECK (Realistic)
   ===================================================== */

async function checkConnection() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    await fetch("https://trustlens-api.onrender.com/health", {
      method: "GET",
      signal: controller.signal
    });

    clearTimeout(timeout);
    updateStatus(true);
  } catch {
    updateStatus(false);
  }
}

function updateStatus(online) {
  dom.statusIndicator.className =
    "status-indicator" + (online ? "" : " offline");

  dom.statusText.textContent = online
    ? "Connected"
    : "Offline Mode";

  dom.syncTime.textContent = online
    ? `Last sync: ${new Date().toLocaleTimeString()}`
    : "Using cached results";
}

/* =====================================================
   HELPERS
   ===================================================== */

function toggle(el, show) {
  el.classList.toggle("hidden", !show);
}

function scoreColor(score) {
  if (score >= 70) return "#4CAF50";
  if (score >= 40) return "#FF9800";
  return "#F44336";
}

function verdictClass(verdict) {
  const v = verdict?.toLowerCase();
  if (v === "verified") return "verified";
  if (v === "false") return "false";
  return "unverifiable";
}

function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}
