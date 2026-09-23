// Data & Storage panel: storage metrics, full export/import, granular resets, and factory reset.
//
// Contract
//   - `mountDataPanel(root, options)` owns the Data & Storage tab.
//   - Options:
//       confirm(opts)        -> Promise<boolean> from confirm.js
//       host                 -> toast host from createToastHost (optional)
//       onDataChanged()      -> callback when cards/sessions/presets change
//   - Returns `{ refresh, destroy }`.

import { el, qs } from "../dom.js";
import { LocalDb } from "../../local_db.js";
import {
  readBrowserCookies,
  restoreBrowserCookies,
  clearBrowserCookies,
  downloadBackupFile,
  readBackupFile,
} from "../data_transfer.js";
import { confirmAction } from "../confirm.js";

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function mountDataPanel(root, options = {}) {
  const { host, onDataChanged } = options;
  const confirm = options.confirm || confirmAction;
  const showToast = (msg, tone = "info") => host?.toast?.(msg, { tone }) || host?.(msg, tone);

  if (!root) return { refresh: () => {}, destroy: () => {} };

  root.innerHTML = "";

  // Guidance header
  const guidanceEl = el("div", { class: "rp-settings__guidance" }, [
    el("p", { class: "rp-settings__guidance-title", text: "Data & Storage Management" }),
    el("p", {
      class: "rp-settings__guidance-text",
      text: "Export complete browser backups, restore from files, or perform granular storage resets. All data is kept strictly inside this browser.",
    }),
  ]);

  // Storage metrics block
  const statsWrap = el("div", { class: "rp-storage-stats" });

  const renderStats = async () => {
    try {
      const stats = await LocalDb.getStorageStats();
      const cookies = readBrowserCookies();
      statsWrap.innerHTML = "";

      const items = [
        { label: "Cards", count: stats.cardCount },
        { label: "Conversations", count: stats.sessionCount },
        { label: "Personas", count: stats.personaCount },
        { label: "System Prompts", count: stats.directiveCount },
        { label: "Cookies", count: cookies.length },
      ];

      for (const item of items) {
        statsWrap.appendChild(
          el("div", { class: "rp-storage-stat" }, [
            el("span", { class: "rp-storage-stat__label", text: item.label }),
            el("span", { class: "rp-badge rp-badge--count rp-tnum", text: String(item.count) }),
          ])
        );
      }

      if (stats.usage > 0) {
        statsWrap.appendChild(
          el("div", { class: "rp-storage-stat" }, [
            el("span", { class: "rp-storage-stat__label", text: "Disk Estimate" }),
            el("span", { class: "rp-badge", text: formatBytes(stats.usage) }),
          ])
        );
      }
    } catch (_) {}
  };

  // Section 1: Backup & Restore
  const backupNotice = el("p", {
    class: "rp-help",
    text: "Backups contain your stored API keys, cards, chat transcripts, custom personas, system prompts, and cookies. Store your backup file securely.",
  });

  const exportBtn = el("button", {
    type: "button",
    id: "rp-data-export-btn",
    class: "rp-btn rp-btn--primary rp-btn--md",
    text: "Export All Browser Data (JSON)",
  });

  const importInput = el("input", {
    type: "file",
    id: "rp-data-import-input",
    accept: ".json,application/json",
    attrs: { hidden: true },
  });

  const importBtn = el("button", {
    type: "button",
    id: "rp-data-import-btn",
    class: "rp-btn rp-btn--secondary rp-btn--md",
    text: "Import Backup File",
  });

  const backupActions = el("div", { class: "rp-actions-row" }, [
    exportBtn,
    importBtn,
    importInput,
  ]);

  const backupSection = el("div", { class: "rp-field" }, [
    el("span", { class: "rp-label", text: "Full Backup & Restore" }),
    backupNotice,
    backupActions,
  ]);

  // Section 2: Granular Resets
  const clearSessionsBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm",
    text: "Clear all conversations",
  });

  const clearCardsBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm",
    text: "Clear character library",
  });

  const resetPersonasBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm",
    text: "Reset personas to default",
  });

  const resetDirectivesBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm",
    text: "Reset system prompts to default",
  });

  const resetSettingsBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm",
    text: "Reset API & generation settings",
  });

  const clearAuthBtn = el("button", {
    type: "button",
    class: "rp-btn rp-btn--ghost rp-btn--sm",
    text: "Clear import session & cookies",
  });

  const granularActions = el("div", { class: "rp-actions-row" }, [
    clearSessionsBtn,
    clearCardsBtn,
    resetPersonasBtn,
    resetDirectivesBtn,
    resetSettingsBtn,
    clearAuthBtn,
  ]);

  const granularSection = el("div", { class: "rp-field" }, [
    el("span", { class: "rp-label", text: "Granular Resets" }),
    el("p", {
      class: "rp-help",
      text: "Targeted resets allow deleting conversations or resetting presets without losing your full configuration.",
    }),
    granularActions,
  ]);

  // Section 3: Factory Reset / Danger Zone
  const factoryResetBtn = el("button", {
    type: "button",
    id: "rp-factory-reset-btn",
    class: "rp-btn rp-btn--danger rp-btn--md",
    text: "Wipe everything & reset browser",
  });

  const dangerZone = el("div", { class: "rp-settings__danger-zone" }, [
    el("p", { class: "rp-settings__danger-title", text: "Danger Zone: Factory Reset" }),
    el("p", {
      class: "rp-settings__danger-text",
      text: "Permanently erase all character cards, chat sessions, custom personas, system prompts, API settings, and browser cookies. Restores Vibe RP to pristine factory state.",
    }),
    factoryResetBtn,
  ]);

  root.append(guidanceEl, statsWrap, backupSection, granularSection, dangerZone);

  // Wire Event Listeners
  const unsubs = [];

  // Export handler
  unsubs.push(
    on(exportBtn, "click", async () => {
      try {
        const cookies = readBrowserCookies();
        const backup = await LocalDb.exportAllData({ cookies });
        const name = downloadBackupFile(backup);
        showToast(`Exported full backup (${name}).`, "success");
      } catch (err) {
        showToast(`Export failed: ${err.message}`, "error");
      }
    })
  );

  // Import handler
  unsubs.push(
    on(importBtn, "click", () => {
      importInput.value = "";
      importInput.click();
    })
  );

  unsubs.push(
    on(importInput, "change", async (e) => {
      const file = e.target.files?.[0];
      importInput.value = "";
      if (!file) return;

      try {
        const payload = await readBackupFile(file);

        // Check if legacy conversation
        if (payload.format === "vibe-rp-conversation") {
          const ok = await confirm({
            title: "Restore conversation?",
            body: `This legacy export contains ${payload.messages?.length || 0} messages. It will be added as a saved conversation.`,
            confirmLabel: "Import Conversation",
          });
          if (!ok) return;

          await LocalDb.importAllData(payload);
          await renderStats();
          onDataChanged?.();
          showToast("Imported conversation successfully.", "success");
          return;
        }

        // Full backup
        if (payload.format === "vibe-rp-full-backup") {
          const cardsCount = payload.data?.indexedDb?.cards?.length || 0;
          const sessionsCount = payload.data?.indexedDb?.sessions?.length || 0;

          const ok = await confirm({
            title: "Restore full backup?",
            body: `Backup contains ${cardsCount} cards and ${sessionsCount} conversations. Existing matching items will be updated.`,
            confirmLabel: "Merge & Restore",
          });
          if (!ok) return;

          const result = await LocalDb.importAllData(payload, { mode: "merge" });
          if (Array.isArray(result.cookies) && result.cookies.length) {
            restoreBrowserCookies(result.cookies);
          }

          await renderStats();
          onDataChanged?.();
          showToast(
            `Restored ${result.cardsImported} cards, ${result.sessionsImported} chats, and settings.`,
            "success"
          );
          return;
        }

        throw new Error("Unrecognized file format: expected a vibe-rp backup file.");
      } catch (err) {
        showToast(`Import failed: ${err.message}`, "error");
      }
    })
  );

  // Granular: Clear Sessions
  unsubs.push(
    on(clearSessionsBtn, "click", async () => {
      const ok = await confirm({
        title: "Clear all conversations?",
        body: "Permanently delete all chat transcripts and histories across all characters. Cards and settings are kept safe.",
        confirmLabel: "Clear Sessions",
        tone: "danger",
        initialFocus: "cancel",
      });
      if (!ok) return;

      try {
        await LocalDb.clearAllSessions();
        await renderStats();
        onDataChanged?.();
        showToast("All conversations cleared.", "success");
      } catch (err) {
        showToast(`Clear failed: ${err.message}`, "error");
      }
    })
  );

  // Granular: Clear Cards
  unsubs.push(
    on(clearCardsBtn, "click", async () => {
      const ok = await confirm({
        title: "Delete all character cards?",
        body: "Permanently delete all character cards and their associated conversation histories. Settings are kept.",
        confirmLabel: "Delete All Cards",
        tone: "danger",
        initialFocus: "cancel",
      });
      if (!ok) return;

      try {
        await LocalDb.clearAllCards();
        await renderStats();
        onDataChanged?.();
        showToast("All character cards deleted.", "success");
      } catch (err) {
        showToast(`Clear failed: ${err.message}`, "error");
      }
    })
  );

  // Granular: Reset Personas
  unsubs.push(
    on(resetPersonasBtn, "click", async () => {
      const ok = await confirm({
        title: "Reset personas to default?",
        body: "Removes all custom author personas and restores the default 'User' persona.",
        confirmLabel: "Reset Personas",
      });
      if (!ok) return;

      LocalDb.resetPersonas();
      await renderStats();
      onDataChanged?.();
      showToast("Personas reset to default.", "success");
    })
  );

  // Granular: Reset Directives
  unsubs.push(
    on(resetDirectivesBtn, "click", async () => {
      const ok = await confirm({
        title: "Reset system prompts to default?",
        body: "Removes all custom directives and restores the canonical Author's Craft Directive.",
        confirmLabel: "Reset Prompts",
      });
      if (!ok) return;

      LocalDb.resetDirectives();
      await renderStats();
      onDataChanged?.();
      showToast("System prompts reset to default.", "success");
    })
  );

  // Granular: Reset Settings
  unsubs.push(
    on(resetSettingsBtn, "click", async () => {
      const ok = await confirm({
        title: "Reset API & generation settings?",
        body: "Reverts API endpoints, keys, models, and sampling sliders to default values.",
        confirmLabel: "Reset Settings",
      });
      if (!ok) return;

      LocalDb.resetSettings();
      await renderStats();
      onDataChanged?.();
      showToast("Inference settings reset to defaults.", "success");
    })
  );

  // Granular: Clear Auth & Cookies
  unsubs.push(
    on(clearAuthBtn, "click", async () => {
      const ok = await confirm({
        title: "Clear import session & cookies?",
        body: "Clears your stored Chub authentication tokens and expires domain cookies.",
        confirmLabel: "Clear Auth",
      });
      if (!ok) return;

      LocalDb.clearImportSession();
      clearBrowserCookies();
      await renderStats();
      showToast("Import session and cookies cleared.", "success");
    })
  );

  // Factory Reset
  unsubs.push(
    on(factoryResetBtn, "click", async () => {
      const ok = await confirm({
        title: "Wipe all browser data?",
        body: "Permanently delete all cards, chat histories, personas, settings, and cookies. This cannot be undone.",
        confirmLabel: "Wipe Everything",
        tone: "danger",
        initialFocus: "cancel",
      });
      if (!ok) return;

      try {
        await LocalDb.wipeAllData({ resetCache: true });
        clearBrowserCookies();
        showToast("All browser data erased. Reloading...", "success");
        setTimeout(() => {
          if (typeof window !== "undefined") window.location.reload();
        }, 600);
      } catch (err) {
        showToast(`Wipe failed: ${err.message}`, "error");
      }
    })
  );

  // Initial stats render
  renderStats();

  return {
    refresh: () => renderStats(),
    destroy: () => {
      for (const unsub of unsubs) unsub?.();
    },
  };
}
