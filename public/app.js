"use strict";

const SESSION_STORAGE_KEY = "wa_session_id";

const els = {
  tabs: document.querySelectorAll(".tab"),
  panels: {
    qr: document.getElementById("panel-qr"),
    pair: document.getElementById("panel-pair"),
  },
  qr: document.getElementById("qr"),
  pairForm: document.getElementById("pair-form"),
  pairSubmit: document.getElementById("pair-submit"),
  phoneInput: document.getElementById("phone"),
  pairCode: document.getElementById("pair-code"),
  pairCodeValue: document.getElementById("pair-code-value"),
  statusDot: document.querySelector(".status-dot"),
  statusText: document.getElementById("status-text"),
  success: document.getElementById("success"),
  successUser: document.getElementById("success-user"),
  logoutBtn: document.getElementById("logout"),
};

let sessionId = null;
let eventSource = null;

function setStatus(status, text) {
  els.statusDot.dataset.status = status || "idle";
  els.statusText.textContent = text;
}

function selectTab(name) {
  els.tabs.forEach((t) => {
    const active = t.dataset.target === `panel-${name}`;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  for (const [key, panel] of Object.entries(els.panels)) {
    const active = key === name;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  }
}

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.target.replace("panel-", "");
    selectTab(target);
  });
});

function renderQR(dataUrl) {
  if (!dataUrl) {
    els.qr.classList.add("placeholder");
    els.qr.innerHTML = "<span>Preparing QR…</span>";
    return;
  }
  els.qr.classList.remove("placeholder");
  els.qr.innerHTML = `<img alt="WhatsApp QR code" src="${dataUrl}" />`;
}

function renderState(state) {
  if (!state || !state.sessionId) return;

  switch (state.status) {
    case "connecting":
      setStatus("connecting", "Connecting to WhatsApp…");
      break;
    case "awaiting_qr":
      setStatus("awaiting_qr", "Waiting for you to scan the QR code…");
      break;
    case "awaiting_pair":
      setStatus(
        "awaiting_pair",
        "Waiting for you to enter the pairing code on your phone…",
      );
      break;
    case "connected":
      setStatus("connected", "Connected.");
      break;
    case "disconnected":
      setStatus(
        "disconnected",
        state.lastError
          ? `Disconnected: ${state.lastError}. Retrying…`
          : "Disconnected. Retrying…",
      );
      break;
    case "logged_out":
      setStatus("logged_out", "Logged out from phone. Start over to relink.");
      break;
    default:
      setStatus("idle", "Idle");
  }

  renderQR(state.qr);

  if (state.pairingCode) {
    els.pairCode.hidden = false;
    els.pairCodeValue.textContent = state.pairingCode;
  }

  if (state.status === "connected") {
    els.success.hidden = false;
    els.successUser.textContent = state.user?.name || state.user?.id || "your number";
  } else {
    els.success.hidden = true;
  }
}

function connectEvents(id) {
  if (eventSource) {
    eventSource.close();
  }
  eventSource = new EventSource(`/api/sessions/${id}/events`);
  eventSource.onmessage = (evt) => {
    try {
      const state = JSON.parse(evt.data);
      renderState(state);
    } catch (err) {
      console.error("bad SSE payload", err);
    }
  };
  eventSource.onerror = () => {
    setStatus("disconnected", "Lost connection to server. Retrying…");
  };
}

async function ensureSession() {
  const stored = localStorage.getItem(SESSION_STORAGE_KEY);
  if (stored) {
    const res = await fetch(`/api/sessions/${stored}`);
    const data = await res.json();
    if (data.status && data.status !== "unknown") {
      sessionId = stored;
      renderState(data);
      connectEvents(sessionId);
      return;
    }
  }

  const res = await fetch("/api/sessions", { method: "POST" });
  if (!res.ok) {
    setStatus("disconnected", "Could not create a session. Refresh the page.");
    return;
  }
  const data = await res.json();
  sessionId = data.sessionId;
  localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  renderState(data);
  connectEvents(sessionId);
}

els.pairForm.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  if (!sessionId) return;
  const phoneNumber = els.phoneInput.value.trim();
  els.pairSubmit.disabled = true;
  els.pairSubmit.textContent = "Requesting…";
  try {
    const res = await fetch(`/api/sessions/${sessionId}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumber }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Failed to request pairing code");
    }
    els.pairCode.hidden = false;
    els.pairCodeValue.textContent = data.pairingCode;
  } catch (err) {
    alert(err.message);
  } finally {
    els.pairSubmit.disabled = false;
    els.pairSubmit.textContent = "Get pairing code";
  }
});

els.logoutBtn.addEventListener("click", async () => {
  if (!sessionId) return;
  if (!confirm("Unlink this device from WhatsApp?")) return;
  await fetch(`/api/sessions/${sessionId}/logout`, { method: "POST" });
  localStorage.removeItem(SESSION_STORAGE_KEY);
  sessionId = null;
  if (eventSource) eventSource.close();
  els.success.hidden = true;
  els.pairCode.hidden = true;
  renderQR(null);
  setStatus("idle", "Unlinked. Refresh to start a new session.");
});

ensureSession();
