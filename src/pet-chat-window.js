"use strict";

// ── Pet chat window runtime (main process) ──
//
// Owns exactly one chat window. Shape decisions, all driven by the same
// constraints the other floating surfaces already live under:
//
//   focusable: TRUE    Unlike permission/update bubbles, the user types here, so
//                      this window must take keyboard focus. That's the whole
//                      reason it isn't focusable:false like update-bubble.
//   parent: pet win    Keeps it associated with the pet for z-order and
//                      minimize behaviour on Windows/macOS.
//   follow the pet     Position comes from the same
//                      computeUpdateBubbleBounds() the update bubble uses, so
//                      the chat window dodges the HUD / permission stack and
//                      stays on-screen across displays by construction.
//
// This module does NOT own conversation state. It renders a transcript it is
// told about and emits user intents (`submit`, `cancel`, `close`, `clear`).
// All model calling lives in pet-chat-session.js.

const { BrowserWindow } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");
const { computeUpdateBubbleBounds } = require("./update-bubble");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";

// CSS px. WIDE_ENOUGH is the point past which the pet's own hit rect stops
// being a useful anchor (the panel would dwarf the pet), so the window parks on
// the side instead of trying to sit under it.
const WIDTH = 380;
const MIN_HEIGHT = 300;
const DEFAULT_HEIGHT = 460;
const MAX_HEIGHT = 720;
const EDGE_MARGIN = 8;
const GAP = 8;
const MAX_WORK_AREA_WIDTH_RATIO = 0.9;
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;

function requiredDependency(value, name) {
  if (!value) throw new Error(`createPetChatWindowRuntime requires ${name}`);
  return value;
}

function isLiveWindow(win) {
  return !!(win && (typeof win.isDestroyed !== "function" || !win.isDestroyed()));
}

function createPetChatWindowRuntime(options = {}) {
  const getPetWindowBounds = requiredDependency(options.getPetWindowBounds, "getPetWindowBounds");
  const getNearestWorkArea = requiredDependency(options.getNearestWorkArea, "getNearestWorkArea");
  const getBubbleWorkArea = options.getBubbleWorkArea || null;
  const getTextScale = options.getTextScale || (() => 1);
  const getHitRectScreen = options.getHitRectScreen || null;
  const getPermissionBubbleBounds = options.getPermissionBubbleBounds || (() => []);
  const getSessionHudBounds = options.getSessionHudBounds || (() => []);
  const repositionQuotaRing = options.repositionQuotaRing || (() => {});
  const guardAlwaysOnTop = options.guardAlwaysOnTop || null;
  const reapplyMacVisibility = options.reapplyMacVisibility || (() => {});
  const petHidden = options.petHidden || (() => false);
  const onWindowCreated = options.onWindowCreated || (() => {});
  const onWindowClosed = options.onWindowClosed || (() => {});
  const logWarn = options.logWarn || ((msg) => console.warn(msg));

  let chatWin = null;
  let pendingPayload = null;
  // Measured by the renderer after each layout pass. Kept across hide/show so
  // reopening at the same transcript height doesn't flash a wrong-sized frame.
  let measuredHeight = DEFAULT_HEIGHT;
  // Set while the user has deliberately collapsed the transcript. Survives
  // hide/show; a fresh open from the pet resets it.
  let collapsed = false;

  function resolveScale(workArea) {
    return clampTextScale(typeof getTextScale === "function" ? getTextScale(workArea) : 1);
  }

  function resolveWorkArea(petBounds) {
    if (typeof getBubbleWorkArea === "function") {
      try { return getBubbleWorkArea(false, petBounds); } catch {}
    }
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    return getNearestWorkArea(cx, cy);
  }

  // computeUpdateBubbleBounds() reads anchor/hit rects as
  // { top, left, right, bottom } — NOT as window bounds { x, y, width, height }.
  // Passing window bounds yields NaN for every coordinate, which silently
  // degrades to a null position. Convert explicitly.
  function toEdgeRect(bounds) {
    if (!bounds) return null;
    if (Number.isFinite(bounds.left) && Number.isFinite(bounds.top)) {
      return {
        left: bounds.left,
        top: bounds.top,
        right: Number.isFinite(bounds.right) ? bounds.right : bounds.left + (bounds.width || 0),
        bottom: Number.isFinite(bounds.bottom) ? bounds.bottom : bounds.top + (bounds.height || 0),
      };
    }
    if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null;
    return {
      left: bounds.x,
      top: bounds.y,
      right: bounds.x + bounds.width,
      bottom: bounds.y + bounds.height,
    };
  }

  function getAnchorRect(petBounds) {
    // Anchor on the pet itself (its hit rect when we have a provider for it),
    // so a chat panel never covers the character.
    if (typeof getHitRectScreen === "function") {
      try {
        const hit = getHitRectScreen(petBounds);
        const rect = toEdgeRect(hit);
        if (rect) return rect;
      } catch {}
    }
    return toEdgeRect(petBounds);
  }

  function getAvoidRects() {
    const rects = [];
    for (const getter of [getPermissionBubbleBounds, getSessionHudBounds]) {
      try {
        const value = getter();
        if (Array.isArray(value)) rects.push(...value);
        else if (value) rects.push(value);
      } catch {}
    }
    return rects.filter((rect) => rect && Number.isFinite(rect.x)
      && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height));
  }

  function computeBounds() {
    const petBounds = getPetWindowBounds();
    if (!petBounds) return null;
    const workArea = resolveWorkArea(petBounds);
    const scale = resolveScale(workArea);
    const rawHeight = collapsed ? MIN_HEIGHT : measuredHeight;
    const height = scaleHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, rawHeight)), scale);
    const width = Math.min(
      scaleWidth(WIDTH, scale),
      Math.max(scaleWidth(240, scale), Math.floor(workArea.width * MAX_WORK_AREA_WIDTH_RATIO))
    );
    const anchorRect = getAnchorRect(petBounds);
    return computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      followPreference: "auto",
      width,
      edgeMargin: Math.round(EDGE_MARGIN * scale),
      gap: Math.round(GAP * scale),
      height,
      reservedHeight: 0,
      workArea,
      petBounds,
      anchorRect,
      hitRect: toEdgeRect(petBounds),
      avoidRects: getAvoidRects(),
    });
  }

  function ensureWindow() {
    if (isLiveWindow(chatWin)) return chatWin;
    const bounds = computeBounds();
    chatWin = new BrowserWindow({
      width: bounds ? bounds.width : WIDTH,
      height: bounds ? bounds.height : DEFAULT_HEIGHT,
      x: bounds ? bounds.x : undefined,
      y: bounds ? bounds.y : undefined,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Unlike the passive bubbles, this window takes real keyboard focus —
      // the user types into it. `parent` keeps it tied to the pet window.
      parent: options.getPetWindow ? options.getPetWindow() : undefined,
      alwaysOnTop: !isMac,
      focusable: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-pet-chat.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    if (isWin) chatWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof guardAlwaysOnTop === "function") guardAlwaysOnTop(chatWin);

    chatWin.loadFile(path.join(__dirname, "pet-chat.html"));
    chatWin.on("closed", () => {
      chatWin = null;
      try { repositionQuotaRing(); } catch {}
      onWindowClosed();
    });
    chatWin.webContents.once("did-finish-load", () => {
      const boundsNow = computeBounds();
      if (boundsNow) chatWin.setBounds(boundsNow);
      const petBounds = getPetWindowBounds();
      const workArea = petBounds ? resolveWorkArea(petBounds) : null;
      if (workArea) applyZoomToWindow(chatWin, resolveScale(workArea));
      if (pendingPayload) chatWin.webContents.send("pet-chat:state", pendingPayload);
    });
    chatWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    chatWin.webContents.on("will-navigate", (event) => {
      // The renderer only ever renders local UI; any navigation is unexpected.
      event.preventDefault();
    });
    onWindowCreated(chatWin);
    return chatWin;
  }

  function reposition() {
    if (!isLiveWindow(chatWin)) return;
    const bounds = computeBounds();
    if (!bounds) return;
    const petBounds = getPetWindowBounds();
    if (petBounds) {
      const workArea = resolveWorkArea(petBounds);
      applyZoomToWindow(chatWin, resolveScale(workArea));
    }
    chatWin.setBounds(bounds);
    // The chat panel can cover the pet: re-run the z-order pass so permission
    // bubbles and the HUD do not end up behind it.
    try { repositionQuotaRing(); } catch {}
  }

  // Re-render without losing the window identity (used by theme/language switches).
  function refreshTranscript(payload) {
    pendingPayload = payload;
    if (!isLiveWindow(chatWin)) return false;
    if (chatWin.webContents.isLoading()) return false;
    chatWin.webContents.send("pet-chat:state", payload);
    return true;
  }

  function show(payload) {
    pendingPayload = payload;
    if (payload && payload.collapsed !== undefined) collapsed = !!payload.collapsed;
    const winRef = ensureWindow();
    if (!winRef) return false;
    if (winRef.webContents.isLoading()) {
      // did-finish-load will send pendingPayload and position the window.
      return true;
    }
    const bounds = computeBounds();
    if (bounds) winRef.setBounds(bounds);
    winRef.show();
    winRef.focus();
    keepOutOfTaskbar(winRef);
    if (isMac) {
      // Same deferred-visibility dance the other floating surfaces use: the
      // panel is re-topmosted a beat later so an in-flight Space switch on
      // macOS doesn't eat the very first show.
      setTimeout(() => {
        if (!isLiveWindow(winRef)) return;
        reapplyMacVisibility();
      }, MAC_FLOATING_TOPMOST_DELAY_MS);
      reapplyMacVisibility();
    }
    if (pendingPayload) winRef.webContents.send("pet-chat:state", pendingPayload);
    return true;
  }

  function hide() {
    if (!isLiveWindow(chatWin)) return;
    chatWin.hide();
    try { repositionQuotaRing(); } catch {}
  }

  function destroy() {
    if (!isLiveWindow(chatWin)) {
      chatWin = null;
      return;
    }
    const winRef = chatWin;
    chatWin = null;
    // `destroy()` skips the close handshake, which matters during app quit.
    winRef.destroy();
  }

  function focus() {
    if (!isLiveWindow(chatWin)) return false;
    if (!chatWin.isVisible()) return false;
    chatWin.focus();
    return true;
  }

  function isVisible() {
    return isLiveWindow(chatWin) && chatWin.isVisible();
  }

  function getWindow() {
    return isLiveWindow(chatWin) ? chatWin : null;
  }

  function handleMeasuredHeight(height) {
    if (!Number.isFinite(height)) return false;
    const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)));
    if (next === measuredHeight) return false;
    measuredHeight = next;
    if (isVisible() && !collapsed) reposition();
    return true;
  }

  function setCollapsed(value) {
    collapsed = !!value;
    if (isVisible()) reposition();
    return collapsed;
  }

  // The pet was hidden by the user: chat goes with it. It comes back through an
  // explicit click, never automatically.
  function syncWithPetVisibility(hidden) {
    if (hidden && isVisible()) hide();
  }

  return {
    DEFAULT_HEIGHT,
    MIN_HEIGHT,
    MAX_HEIGHT,
    WIDTH,
    computeBounds,
    destroy,
    focus,
    getWindow,
    handleMeasuredHeight,
    hide,
    isVisible,
    refreshTranscript,
    reposition,
    setCollapsed,
    show,
    syncWithPetVisibility,
    __test: { computeBounds },
  };
}

module.exports = { createPetChatWindowRuntime };