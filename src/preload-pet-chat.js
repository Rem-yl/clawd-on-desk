"use strict";

// ── Pet chat window preload ──
//
// Surface: window.petChatAPI
//
//   getState()              Promise<snapshot>            full transcript + status
//   onState(cb)             subscribe to pushed snapshots
//   submit(text)            send a user turn
//   stop()                  abort the in-flight reply
//   clear()                 wipe the transcript
//   close()                 hide the window
//   setCollapsed(bool)      collapse/expand the transcript
//   reportHeight(px)        measured outer height for positioning
//
// The renderer never holds conversation state: it re-renders from the last
// snapshot main pushed, exactly like the Settings panel.

const { contextBridge, ipcRenderer } = require("electron");

const stateListeners = new Set();
const langListeners = new Set();

function fanout(set, payload) {
  for (const cb of set) {
    try { cb(payload); } catch (err) { console.warn("pet chat listener threw:", err); }
  }
}

ipcRenderer.on("pet-chat:state", (_event, snapshot) => fanout(stateListeners, snapshot));
ipcRenderer.on("pet-chat:i18n", (_event, payload) => fanout(langListeners, payload));

contextBridge.exposeInMainWorld("petChatAPI", {
  getState: () => ipcRenderer.invoke("pet-chat:get-state"),
  onState: (cb) => {
    if (typeof cb !== "function") return () => {};
    stateListeners.add(cb);
    return () => stateListeners.delete(cb);
  },
  onI18n: (cb) => {
    if (typeof cb !== "function") return () => {};
    langListeners.add(cb);
    return () => langListeners.delete(cb);
  },
  submit: (text) => ipcRenderer.invoke("pet-chat:submit", text),
  stop: () => ipcRenderer.send("pet-chat:stop"),
  clear: () => ipcRenderer.invoke("pet-chat:clear"),
  close: () => ipcRenderer.send("pet-chat:close"),
  setCollapsed: (value) => ipcRenderer.send("pet-chat:set-collapsed", !!value),
  reportHeight: (px) => ipcRenderer.send("pet-chat:height", px),
});