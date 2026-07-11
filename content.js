/* =====================================================
   TrustLens Live – Content Script v3.0
   Secure • Performant • Scalable
   ===================================================== */

(() => {

  /* ===============================
     Internal State
     =============================== */

  let currentSelection = null;
  let lastResult = null;
  let isProcessing = false;
  let floatTimeout = null;

  const HIGHLIGHT_CLASS = "trust-highlight";
  const CARD_ID = "trustlens-float";
  const INDICATOR_ID = "trustlens-selection-indicator";
  const MAX_Z = 2147483647;

  const CONFIG = {
    minSelectionLength: 10,
    maxSelectionLength: 2000,
    debounceTime: 250,
    popupDuration: 6000,
    trustLevels: { high: 70, medium: 40 }
  };

  /* ===============================
     Utility – Safe Text
     =============================== */

  function safeText(value) {
    return document.createTextNode(value || "");
  }

  function createEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.appendChild(safeText(text));
    return el;
  }

  /* ===============================
     Selection Handling
     =============================== */

  let selectionTimer = null;

  document.addEventListener("mouseup", debounceSelection);
  document.addEventListener("keyup", debounceSelection);

  function debounceSelection(e) {
    if (e.target.closest?.(`#${CARD_ID}`)) return;

    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(handleSelection, CONFIG.debounceTime);
  }

  function handleSelection() {
    if (isProcessing) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const text = selection.toString().trim();
    if (text.length < CONFIG.minSelectionLength) return;
    if (text.length > CONFIG.maxSelectionLength) return;

    const range = selection.getRangeAt(0);
    if (!isValidRange(range)) return;

    currentSelection = range.cloneRange();
    showIndicator(range);

    chrome.runtime.sendMessage({
      type: "TEXT_SELECTED",
      text
    });

    isProcessing = true;
  }

  function isValidRange(range) {
    if (!range.collapsed &&
        range.startContainer.nodeType === Node.TEXT_NODE &&
        range.endContainer.nodeType === Node.TEXT_NODE &&
        range.startContainer.parentNode === range.endContainer.parentNode) {
      return true;
    }
    return false;
  }

  /* ===============================
     Selection Indicator
     =============================== */

  function showIndicator(range) {
    removeIndicator();

    const rect = range.getBoundingClientRect();
    if (!rect.width) return;

    const indicator = createEl("div", "", "🔍 Verifying...");
    indicator.id = INDICATOR_ID;

    Object.assign(indicator.style, {
      position: "fixed",
      top: `${rect.bottom + 8}px`,
      left: `${rect.left}px`,
      background: "rgba(0,0,0,0.8)",
      color: "white",
      padding: "4px 8px",
      borderRadius: "6px",
      fontSize: "12px",
      zIndex: MAX_Z,
      pointerEvents: "none"
    });

    document.body.appendChild(indicator);
  }

  function removeIndicator() {
    document.getElementById(INDICATOR_ID)?.remove();
  }

  /* ===============================
     Message Listener
     =============================== */

  chrome.runtime.onMessage.addListener((msg) => {

    if (msg.type === "SHOW_TRUST_RESULT") {
      removeIndicator();
      isProcessing = false;
      if (!currentSelection) return;

      highlight(currentSelection, msg.result);
      showCard(currentSelection, msg.result);
      lastResult = msg.result;
    }

    if (msg.type === "VERIFICATION_ERROR") {
      removeIndicator();
      isProcessing = false;
      showError(msg.error);
    }

    return true;
  });

  /* ===============================
     Highlight (Safer Approach)
     =============================== */

  function highlight(range, result) {
    try {
      const span = document.createElement("span");
      span.classList.add(HIGHLIGHT_CLASS);

      const score = result.score || 0;
      if (score >= CONFIG.trustLevels.high) span.classList.add("trust-true");
      else if (score >= CONFIG.trustLevels.medium) span.classList.add("trust-mixed");
      else span.classList.add("trust-false");

      span.dataset.trustScore = score;
      span.dataset.trustVerdict = result.verdict || "";

      range.surroundContents(span);

      span.addEventListener("click", e => {
        e.stopPropagation();
        showCardForElement(span, result);
      });

      window.getSelection().removeAllRanges();

    } catch (err) {
      console.warn("Highlight failed safely:", err);
    }
  }

  /* ===============================
     Floating Card (Safe DOM Build)
     =============================== */

  function showCard(range, result) {
    removeCard();

    const rect = range.getBoundingClientRect();
    if (!rect.width) return;

    const card = buildCard(result);
    positionCard(card, rect);

    document.body.appendChild(card);

    floatTimeout = setTimeout(() => card.remove(), CONFIG.popupDuration);
  }

  function showCardForElement(el, result) {
    const rect = el.getBoundingClientRect();
    const card = buildCard(result);
    positionCard(card, rect);
    document.body.appendChild(card);
  }

  function buildCard(result) {

    const card = createEl("div", "trustlens-card");
    card.id = CARD_ID;
    card.style.position = "fixed";
    card.style.zIndex = MAX_Z;

    const score = result.score || 0;

    if (score >= CONFIG.trustLevels.high) card.classList.add("green");
    else if (score >= CONFIG.trustLevels.medium) card.classList.add("orange");
    else card.classList.add("red");

    const header = createEl("div", "trustlens-header");
    const title = createEl("h4", "", "TrustLens Live");
    const close = createEl("button", "trustlens-close", "✕");

    close.addEventListener("click", () => card.remove());

    header.append(title, close);

    const scoreBox = createEl("div", "trustlens-score");
    const scoreVal = createEl("div", "score-value", `${score}%`);
    const scoreLabel = createEl("div", "score-label", "Trust Score");
    scoreBox.append(scoreVal, scoreLabel);

    const verdict = createEl(
      "div",
      "trustlens-verdict",
      result.verdict || "Analysis"
    );

    const reason = createEl(
      "div",
      "trustlens-reason",
      result.explanation || "No explanation provided."
    );

    card.append(header, scoreBox, verdict, reason);

    return card;
  }

  function positionCard(card, rect) {
    const margin = 12;
    let top = rect.bottom + margin;
    let left = rect.left;

    const maxRight = window.innerWidth - 340;
    if (left > maxRight) left = maxRight;
    if (top > window.innerHeight - 200)
      top = rect.top - 180;

    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }

  function removeCard() {
    clearTimeout(floatTimeout);
    document.getElementById(CARD_ID)?.remove();
  }

  /* ===============================
     Error Handling
     =============================== */

  function showError(message) {
    removeCard();

    const card = createEl("div", "trustlens-card red");
    card.id = CARD_ID;
    card.style.position = "fixed";
    card.style.top = "50%";
    card.style.left = "50%";
    card.style.transform = "translate(-50%, -50%)";
    card.style.zIndex = MAX_Z;

    card.appendChild(createEl("div", "trustlens-reason", message || "Verification failed."));
    document.body.appendChild(card);

    setTimeout(() => card.remove(), 3000);
  }

  /* ===============================
     Cleanup
     =============================== */

  window.addEventListener("beforeunload", () => {
    removeCard();
    removeIndicator();
  });

})();
