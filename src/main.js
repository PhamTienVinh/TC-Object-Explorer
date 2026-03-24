/**
 * main.js — Trimble Connect Workspace API Connection
 *
 * Connects to TC Workspace API using the event-callback pattern.
 * All events flow through the connect() callback → dispatched to registered listeners.
 */

import { connect } from "trimble-connect-workspace-api";
import { initObjectExplorer } from "./objectExplorer.js";
import { initSteelStatistics } from "./steelStatistics.js";

// ── State ──
let api = null;
let viewer = null;
const eventListeners = {};

// ── Public API ──
export function getApi() { return api; }
export function getViewer() { return viewer; }

/**
 * Register an event listener for TC Workspace events.
 * Events: "viewer.onModelStateChanged", "viewer.onSelectionChanged", etc.
 */
export function onEvent(eventId, callback) {
  if (!eventListeners[eventId]) eventListeners[eventId] = [];
  eventListeners[eventId].push(callback);
}

function dispatchEvent(eventId, data) {
  const listeners = eventListeners[eventId];
  if (listeners) {
    listeners.forEach((cb) => {
      try { cb(data); } catch (e) { console.error(`[Event ${eventId}] handler error:`, e); }
    });
  }
}

// ── UI Helpers ──
function setConnectionStatus(connected, text) {
  const badge = document.getElementById("connection-status");
  if (!badge) return;
  const statusText = badge.querySelector(".status-text");
  badge.className = `status-badge ${connected ? "connected" : "disconnected"}`;
  statusText.textContent = text || (connected ? "Đã kết nối" : "Đang kết nối...");
}

// ── Tab Switching ──
function initTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      tabBtns.forEach((b) => b.classList.remove("active"));
      tabContents.forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${tabId}`).classList.add("active");
    });
  });
}

// ── Main Initialization ──
async function init() {
  console.log("[TC Extension] Initializing...");
  initTabs();

  // Check if we're inside an iframe (required for TC extension)
  const isInIframe = window.parent !== window;
  if (!isInIframe) {
    console.warn("[TC Extension] Not running inside an iframe. TC Workspace API requires iframe context.");
    setConnectionStatus(false, "Không trong iframe");
    return;
  }

  try {
    setConnectionStatus(false, "Đang kết nối...");

    // Connect with event callback — THE CORRECT WAY for TC Workspace API
    // The second argument is the event callback that receives ALL events
    api = await connect(
      window.parent,
      (event, data) => {
        console.log("[TC Event]", event, data);
        dispatchEvent(event, data);
      },
      15000 // 15 second timeout
    );

    viewer = api.viewer;
    setConnectionStatus(true, "Đã kết nối");
    console.log("[TC Extension] Connected to Workspace API successfully");
    console.log("[TC Extension] API keys:", Object.keys(api));
    console.log("[TC Extension] Viewer keys:", viewer ? Object.keys(viewer) : "null");

    // Request access token permission
    try {
      await api.extension.requestPermission("accesstoken");
      console.log("[TC Extension] Access token permission granted");
    } catch (e) {
      console.warn("[TC Extension] Permission request failed (may be OK in some contexts):", e.message || e);
    }

    // Initialize feature modules — pass api and viewer references
    initObjectExplorer(api, viewer);
    initSteelStatistics(api, viewer);

    // Check if models are already loaded
    await checkExistingModels();

  } catch (error) {
    console.error("[TC Extension] Connection failed:", error);
    setConnectionStatus(false, "Lỗi kết nối");

    // Log more details for debugging
    if (error.message) {
      console.error("[TC Extension] Error message:", error.message);
    }
    if (error.stack) {
      console.error("[TC Extension] Stack:", error.stack);
    }
  }
}

// ── Check for already-loaded models ──
async function checkExistingModels() {
  try {
    // Try getModels() without filter first (most compatible)
    const allModels = await viewer.getModels();
    console.log("[TC Extension] All models:", allModels);

    if (allModels && allModels.length > 0) {
      // Filter for loaded models
      const loadedModels = allModels.filter(m => m.state === "loaded");
      console.log("[TC Extension] Loaded models:", loadedModels.length, "of", allModels.length);

      if (loadedModels.length > 0) {
        // Models are already loaded — trigger scan
        console.log("[TC Extension] Triggering initial scan for loaded models");
        dispatchEvent("viewer.onModelStateChanged", { models: loadedModels });
      } else {
        console.log("[TC Extension] No models loaded yet, waiting for onModelStateChanged event...");
      }
    } else {
      console.log("[TC Extension] No models found, waiting for user to load a model...");
    }
  } catch (e) {
    console.warn("[TC Extension] Could not check existing models:", e.message || e);
    console.log("[TC Extension] Will rely on onModelStateChanged event");
  }
}

// ── Start ──
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
