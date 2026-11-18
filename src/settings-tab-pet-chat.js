"use strict";

// Pet chat settings tab: model endpoint + key, persona, memory, transcript.
//
// Follows the Settings-tab contract used by every other page:
//   - the page owns rendering and commands, never state;
//   - non-secret config goes through window.settingsAPI.update("petChat", …);
//   - the API key goes through the dedicated pet-chat key channels so a generic
//     prefs write can never plant a spendable secret;
//   - the page re-renders from the snapshot delivered by onChanged.
(function initSettingsTabPetChat(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  const view = {
    // Draft fields are local until the user commits them; without this a
    // re-render mid-typing would yank the caret and revert the text.
    baseUrlDraft: null,
    baseUrlDirty: false,
    modelDraft: null,
    modelDirty: false,
    personaDraft: null,
    personaDirty: false,
    apiKeyDraft: "",
    keyPending: false,
    memoryDraft: null,
    memoryDirty: false,
    memoryLoaded: false,
    status: null,
  };

  function t(key) {
    return helpers.t(key);
  }

  function currentConfig() {
    const cfg = state.snapshot && state.snapshot.petChat;
    return {
      enabled: !!(cfg && cfg.enabled),
      baseUrl: cfg && typeof cfg.baseUrl === "string" ? cfg.baseUrl : "",
      model: cfg && typeof cfg.model === "string" ? cfg.model : "",
      persona: cfg && typeof cfg.persona === "string" ? cfg.persona : "",
      memoryEnabled: !cfg || cfg.memoryEnabled !== false,
      maxHistoryMessages: cfg && Number.isInteger(cfg.maxHistoryMessages) ? cfg.maxHistoryMessages : 40,
      temperature: cfg && Number.isFinite(cfg.temperature) ? cfg.temperature : 0.8,
      openOnClick: !cfg || cfg.openOnClick !== false,
      petReactions: !cfg || cfg.petReactions !== false,
    };
  }

  function saveConfig(patch, { toastKey = "petChatSaved" } = {}) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return Promise.resolve(null);
    }
    const next = { ...currentConfig(), ...patch };
    return window.settingsAPI.update("petChat", next).then((result) => {
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("toastSaveFailed"), { error: true });
        return null;
      }
      if (toastKey) ops.showToast(t(toastKey));
      ops.requestRender({ content: true });
      return result;
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      return null;
    });
  }

  // Re-renders ONLY when the status actually changed. render() calls this, so an
  // unconditional requestRender here would loop forever (render → refresh →
  // render → …). Compared on the fields the page can display.
  let lastStatusKey = null;

  function refreshStatus() {
    if (!window.settingsAPI || typeof window.settingsAPI.getPetChatStatus !== "function") return;
    window.settingsAPI.getPetChatStatus().then((status) => {
      if (!status || status.status === "error") return;
      view.status = status;
      const key = JSON.stringify([
        status.enabled, status.ready, status.reason, status.hasApiKey,
        status.model, status.baseUrl,
      ]);
      if (key === lastStatusKey) return;
      lastStatusKey = key;
      if (state.activeTab === "pet-chat") ops.requestRender({ content: true });
    }).catch(() => {});
  }

  // ── Rows ──

  function buildRow(labelKey, descKey, controlNode) {
    const row = document.createElement("div");
    row.className = "row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.id = `pet-chat-${labelKey}-label`;
    label.textContent = t(labelKey);
    text.appendChild(label);
    if (descKey) {
      const desc = document.createElement("span");
      desc.className = "row-desc";
      desc.id = `pet-chat-${labelKey}-desc`;
      desc.textContent = t(descKey);
      text.appendChild(desc);
    }
    row.appendChild(text);
    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    ctrl.appendChild(controlNode);
    row.appendChild(ctrl);
    return row;
  }

  function loadMemoryOnce() {
    if (view.memoryLoaded) return;
    view.memoryLoaded = true;
    if (!window.settingsAPI || typeof window.settingsAPI.getPetChatMemory !== "function") {
      view.memoryDraft = "";
      return;
    }
    window.settingsAPI.getPetChatMemory().then((result) => {
      if (!result || result.status !== "ok") return;
      view.memoryDraft = typeof result.text === "string" ? result.text : "";
      view.memoryDirty = false;
      if (state.activeTab === "pet-chat") ops.requestRender({ content: true });
    }).catch(() => {});
  }

  // buildSwitchRow() is wired to flat prefs keys — it reads `snapshot[key]` and
  // auto-commits that key. `petChat` is one nested object, so this page builds
  // its switches from the primitive buildSwitch() instead and commits the whole
  // config object itself. Using buildSwitchRow here silently rendered every
  // toggle as "off" and toggled the wrong value.
  function buildConfigSwitchRow({ labelKey, descKey, checked, disabled = false, onCommit }) {
    const row = document.createElement("div");
    row.className = "row";
    if (disabled) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t(labelKey);
    text.appendChild(label);
    if (descKey) {
      const desc = document.createElement("span");
      desc.className = "row-desc";
      desc.textContent = t(descKey);
      text.appendChild(desc);
    }
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const control = helpers.buildSwitch({
      checked: checked === true,
      disabled,
      ariaLabel: t(labelKey),
      onToggle: ({ nextChecked }) => {
        control.setState({ checked: nextChecked, pending: true });
        Promise.resolve(onCommit(nextChecked)).then((ok) => {
          // Revert when the write failed; a page re-render also follows.
          control.setState({ checked: ok ? nextChecked : checked, pending: false });
          if (!ok) ops.requestRender({ content: true });
        }).catch(() => {
          control.setState({ checked, pending: false });
        });
      },
    });
    ctrl.appendChild(control.element);
    row.appendChild(ctrl);
    return row;
  }

  function saveConfigBoolean(patch) {
    return saveConfig(patch, { toastKey: null }).then((result) => !!result);
  }

  function buildStatusCard() {
    const card = document.createElement("div");
    card.className = "section";
    const status = view.status;
    const parts = [];
    if (!status) {
      parts.push(t("petChatStatusUnknown"));
    } else if (!status.enabled) {
      parts.push(t("petChatStatusDisabled"));
    } else if (!status.ready) {
      parts.push(t(`petChatReason_${status.reason}`) || t("petChatStatusIncomplete"));
    } else {
      parts.push(t("petChatStatusReady"));
    }
    const p = document.createElement("p");
    p.className = "subtitle";
    p.textContent = parts.filter(Boolean).join(" ");
    card.appendChild(p);
    if (status && status.ready) {
      const meta = document.createElement("p");
      meta.className = "subtitle";
      meta.textContent = `${status.model} · ${status.baseUrl}`;
      card.appendChild(meta);
    }
    return card;
  }

  function buildBaseUrlRow() {
    const cfg = currentConfig();
    if (view.baseUrlDraft === null || !view.baseUrlDirty) view.baseUrlDraft = cfg.baseUrl;
    const input = helpers.buildTextInput({
      type: "text",
      inputMode: "url",
      spellcheck: false,
      placeholder: t("petChatBaseUrlPlaceholder"),
      className: "tg-approval-input",
      ariaLabel: t("petChatBaseUrlLabel"),
      value: view.baseUrlDraft || "",
    });
    input.addEventListener("input", () => {
      view.baseUrlDraft = input.value;
      view.baseUrlDirty = true;
    });
    input.addEventListener("blur", () => {
      if (!view.baseUrlDirty) return;
      const next = input.value.trim();
      if (next === cfg.baseUrl) return;
      view.baseUrlDirty = false;
      saveConfig({ baseUrl: next });
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
    return buildRow("petChatBaseUrlLabel", "petChatBaseUrlDesc", input);
  }

  function buildModelRow() {
    const cfg = currentConfig();
    if (view.modelDraft === null || !view.modelDirty) view.modelDraft = cfg.model;
    const input = helpers.buildTextInput({
      type: "text",
      spellcheck: false,
      placeholder: t("petChatModelPlaceholder"),
      className: "tg-approval-input",
      ariaLabel: t("petChatModelLabel"),
      value: view.modelDraft || "",
    });
    input.addEventListener("input", () => {
      view.modelDraft = input.value;
      view.modelDirty = true;
    });
    input.addEventListener("blur", () => {
      if (!view.modelDirty) return;
      const next = input.value.trim();
      if (next === cfg.model) return;
      view.modelDirty = false;
      saveConfig({ model: next });
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
    return buildRow("petChatModelLabel", "petChatModelDesc", input);
  }

  function buildKeyRow() {
    const hasKey = !!(view.status && view.status.hasApiKey);
    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.gap = "6px";
    wrapper.style.alignItems = "center";

    const input = helpers.buildTextInput({
      type: "password",
      spellcheck: false,
      placeholder: hasKey ? t("petChatKeyPlaceholderSaved") : t("petChatKeyPlaceholder"),
      className: "tg-approval-input",
      ariaLabel: t("petChatKeyLabel"),
      value: view.apiKeyDraft,
      pending: view.keyPending,
    });
    input.addEventListener("input", () => { view.apiKeyDraft = input.value; });

    const saveBtn = helpers.buildButton({
      labelKey: view.keyPending ? "petChatKeySaving" : "petChatKeySave",
      tone: "accent",
      disabled: view.keyPending,
      pending: view.keyPending,
    });
    saveBtn.addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) return;
      view.keyPending = true;
      ops.requestRender({ content: true });
      window.settingsAPI.setPetChatApiKey(value).then((result) => {
        view.keyPending = false;
        if (!result || result.status !== "ok") {
          ops.showToast((result && result.reason) || t("toastSaveFailed"), { error: true });
          ops.requestRender({ content: true });
          return;
        }
        view.apiKeyDraft = "";
        ops.showToast(t("petChatKeySaved"));
        refreshStatus();
        ops.requestRender({ content: true });
      }).catch((err) => {
        view.keyPending = false;
        ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
        ops.requestRender({ content: true });
      });
    });
    wrapper.appendChild(input);
    wrapper.appendChild(saveBtn);

    if (hasKey) {
      const forgetBtn = helpers.buildButton({
        labelKey: "petChatKeyForget",
        tone: "neutral",
        disabled: view.keyPending,
      });
      forgetBtn.addEventListener("click", () => {
        view.keyPending = true;
        ops.requestRender({ content: true });
        window.settingsAPI.forgetPetChatApiKey().then((result) => {
          view.keyPending = false;
          if (!result || result.status !== "ok") {
            ops.showToast(t("toastSaveFailed"), { error: true });
          } else {
            ops.showToast(t("petChatKeyForgotten"));
          }
          refreshStatus();
          ops.requestRender({ content: true });
        }).catch(() => {
          view.keyPending = false;
          ops.showToast(t("toastSaveFailed"), { error: true });
          ops.requestRender({ content: true });
        });
      });
      wrapper.appendChild(forgetBtn);
    }

    return buildRow("petChatKeyLabel", "petChatKeyDesc", wrapper);
  }

  function buildTextareaRow(labelKey, descKey, { value, maxlength, onInput, onCommit }) {
    const row = document.createElement("div");
    row.className = "row row-stacked";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t(labelKey);
    text.appendChild(label);
    if (descKey) {
      const desc = document.createElement("span");
      desc.className = "row-desc";
      desc.textContent = t(descKey);
      text.appendChild(desc);
    }
    row.appendChild(text);

    const ta = document.createElement("textarea");
    ta.className = "tg-approval-input";
    ta.setAttribute("aria-label", t(labelKey));
    ta.rows = 4;
    ta.maxLength = maxlength;
    ta.style.width = "100%";
    ta.style.resize = "vertical";
    ta.style.fontFamily = "inherit";
    ta.value = value;
    ta.addEventListener("input", () => onInput(ta.value));
    ta.addEventListener("blur", () => onCommit(ta.value));
    row.appendChild(ta);
    return row;
  }

  function buildPersonaRow() {
    const cfg = currentConfig();
    if (view.personaDraft === null || !view.personaDirty) view.personaDraft = cfg.persona;
    return buildTextareaRow("petChatPersonaLabel", "petChatPersonaDesc", {
      value: view.personaDraft,
      maxlength: 4000,
      onInput: (value) => { view.personaDraft = value; view.personaDirty = true; },
      onCommit: (value) => {
        if (!view.personaDirty) return;
        view.personaDirty = false;
        saveConfig({ persona: value });
      },
    });
  }

  function buildMemoryRow() {
    loadMemoryOnce();
    const draft = view.memoryDraft === null ? "" : view.memoryDraft;
    const row = buildTextareaRow("petChatMemoryLabel", "petChatMemoryDesc", {
      value: draft,
      maxlength: 20000,
      onInput: (value) => { view.memoryDraft = value; view.memoryDirty = true; },
      onCommit: (value) => {
        if (!view.memoryDirty) return;
        view.memoryDirty = false;
        window.settingsAPI.savePetChatMemory(value).then((result) => {
          if (!result || result.status !== "ok") {
            ops.showToast(t("toastSaveFailed"), { error: true });
            return;
          }
          ops.showToast(t("petChatMemorySaved"));
        }).catch(() => ops.showToast(t("toastSaveFailed"), { error: true }));
      },
    });
    return row;
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("petChatTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("petChatSubtitle");
    parent.appendChild(subtitle);

    refreshStatus();
    parent.appendChild(buildStatusCard());

    const cfg = currentConfig();

    parent.appendChild(helpers.buildSection(t("petChatSectionConnection"), [
      buildConfigSwitchRow({
        labelKey: "petChatEnableLabel",
        descKey: "petChatEnableDesc",
        checked: cfg.enabled,
        onCommit: (next) => saveConfigBoolean({ enabled: next }),
      }),
      buildBaseUrlRow(),
      buildModelRow(),
      buildKeyRow(),
    ]));

    parent.appendChild(helpers.buildSection(t("petChatSectionBehavior"), [
      buildConfigSwitchRow({
        labelKey: "petChatOpenOnClickLabel",
        descKey: "petChatOpenOnClickDesc",
        checked: cfg.openOnClick,
        onCommit: (next) => saveConfigBoolean({ openOnClick: next }),
      }),
      buildConfigSwitchRow({
        labelKey: "petChatReactionsLabel",
        descKey: "petChatReactionsDesc",
        checked: cfg.petReactions,
        onCommit: (next) => saveConfigBoolean({ petReactions: next }),
      }),
      buildConfigSwitchRow({
        labelKey: "petChatMemoryEnabledLabel",
        descKey: "petChatMemoryEnabledDesc",
        checked: cfg.memoryEnabled,
        onCommit: (next) => saveConfigBoolean({ memoryEnabled: next }),
      }),
      buildPersonaRow(),
    ]));

    const memorySection = helpers.buildSection(t("petChatSectionMemory"), [
      buildMemoryRow(),
    ]);
    const clearRow = document.createElement("div");
    clearRow.className = "row";
    const clearText = document.createElement("div");
    clearText.className = "row-text";
    const clearLabel = document.createElement("span");
    clearLabel.className = "row-label";
    clearLabel.textContent = t("petChatClearHistoryLabel");
    const clearDesc = document.createElement("span");
    clearDesc.className = "row-desc";
    clearDesc.textContent = t("petChatClearHistoryDesc");
    clearText.appendChild(clearLabel);
    clearText.appendChild(clearDesc);
    clearRow.appendChild(clearText);
    const clearCtrl = document.createElement("div");
    clearCtrl.className = "row-control";
    const clearBtn = helpers.buildButton({ labelKey: "petChatClearHistoryButton", tone: "danger" });
    clearBtn.addEventListener("click", () => {
      clearBtn.disabled = true;
      window.settingsAPI.clearPetChatHistory().then((result) => {
        clearBtn.disabled = false;
        ops.showToast(
          result && result.status === "ok" ? t("petChatHistoryCleared") : t("toastSaveFailed"),
          { error: !(result && result.status === "ok") }
        );
      }).catch(() => {
        clearBtn.disabled = false;
        ops.showToast(t("toastSaveFailed"), { error: true });
      });
    });
    clearCtrl.appendChild(clearBtn);
    clearRow.appendChild(clearCtrl);
    memorySection.appendChild(clearRow);
    parent.appendChild(memorySection);

    const note = document.createElement("p");
    note.className = "subtitle";
    note.textContent = t("petChatPrivacyNote");
    parent.appendChild(note);

    if (cfg.memoryEnabled === false) {
      // Keep the textarea reachable but make it obvious it is not being used.
      memorySection.classList.add("pet-chat-section-muted");
    }
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs["pet-chat"] = { render };
    refreshStatus();
  }

  root.ClawdSettingsTabPetChat = { init };
})(globalThis);