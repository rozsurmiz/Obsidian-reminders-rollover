import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, SettingsTab } from "./settings";
import { syncReminders, syncFlaggedReminders, getRemindersLists, getRemindersListsDetailed, setHelperPath } from "./reminders";
import type { ProgressFn } from "./reminders";
import { rolloverTasks } from "./rollover";
import type { PluginSettings } from "./settings";
import * as path from "path";

export default class RemindersRolloverPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;

  /** Show a notice that auto-hides, returning it so we can hide it early */
  private progressNotice: Notice | null = null;

  private showProgress: ProgressFn = (msg: string) => {
    if (this.progressNotice) {
      this.progressNotice.setMessage(msg);
    } else {
      this.progressNotice = new Notice(msg, 0); // 0 = stays until dismissed
    }
  };

  private clearProgress() {
    if (this.progressNotice) {
      this.progressNotice.hide();
      this.progressNotice = null;
    }
  }

  async onload() {
    await this.loadSettings();

    // ── Set up Swift helper path ──
    const adapter = this.app.vault.adapter as any;
    const vaultPath: string = adapter.basePath || adapter.getBasePath?.() || "";
    const pluginDir = path.join(vaultPath, this.manifest.dir || path.join(".obsidian", "plugins", this.manifest.id));
    const helperPath = path.join(pluginDir, "reminders-helper.swift");
    setHelperPath(helperPath);

    // ── Settings tab ──
    this.addSettingTab(new SettingsTab(this.app, this));

    // ── Commands ──

    this.addCommand({
      id: "sync-reminders",
      name: "Sync Apple Reminders",
      callback: async () => {
        this.showProgress("⏳ Syncing Apple Reminders…");
        try {
          const result = await syncReminders(this.app.vault, this.settings, this.showProgress);
          this.clearProgress();
          new Notice(
            `✅ Reminders sync complete — ${result.pulled} pulled, ${result.pushed} pushed, ${result.created} created`
          );
        } catch (e) {
          this.clearProgress();
          console.error("[Reminders Sync]", e);
          new Notice("❌ Reminders sync failed. Check the console for details.");
        }
      },
    });

    this.addCommand({
      id: "rollover-tasks",
      name: "Roll over yesterday's unchecked tasks",
      callback: async () => {
        try {
          const result = await rolloverTasks(this.app.vault, this.settings);
          if (result.count > 0) {
            new Notice(`✅ Rolled over ${result.count} task(s) to today's note.`);
          } else {
            new Notice("No tasks to roll over.");
          }
        } catch (e) {
          console.error("[Task Rollover]", e);
          new Notice("❌ Task rollover failed. Check the console for details.");
        }
      },
    });

    this.addCommand({
      id: "list-reminder-lists",
      name: "Show available Reminders lists",
      callback: async () => {
        try {
          const lists = await getRemindersListsDetailed();
          const msg = lists
            .map((l) => `${l.name} (${l.account}) — ${l.count} items`)
            .join("\n");
          new Notice(`📋 All Reminders lists:\n${msg}`, 12000);
        } catch (e) {
          new Notice("❌ Could not read Reminders lists. Check console.");
          console.error("[List Reminders]", e);
        }
      },
    });

    this.addCommand({
      id: "sync-flagged-reminders",
      name: "Sync flagged reminders (all lists)",
      callback: async () => {
        this.showProgress("⏳ Syncing flagged reminders…");
        try {
          const result = await syncFlaggedReminders(this.app.vault, this.settings, this.showProgress);
          this.clearProgress();
          new Notice(
            `✅ Flagged sync complete — ${result.pulled} pulled, ${result.pushed} pushed`
          );
        } catch (e) {
          this.clearProgress();
          console.error("[Flagged Sync]", e);
          new Notice("❌ Flagged reminders sync failed. Check the console.");
        }
      },
    });

    // ── Startup hooks ──
    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.autoSyncOnStartup) {
        this.showProgress("🔄 Auto-sync starting…");
        try {
          const result = await syncReminders(this.app.vault, this.settings, this.showProgress);
          this.clearProgress();
          if (result.pulled + result.pushed + result.created > 0) {
            new Notice(
              `🔄 Auto-sync: ${result.pulled} pulled, ${result.pushed} pushed, ${result.created} created`
            );
          }
        } catch (e) {
          this.clearProgress();
          console.error("[Auto Reminders Sync]", e);
          new Notice("❌ Auto-sync failed. Check console (Cmd+Option+I).");
        }

        // Also sync flagged if enabled
        if (this.settings.syncFlagged) {
          this.showProgress("🚩 Syncing flagged reminders…");
          try {
            const flagResult = await syncFlaggedReminders(this.app.vault, this.settings, this.showProgress);
            this.clearProgress();
            if (flagResult.pulled + flagResult.pushed > 0) {
              new Notice(
                `🚩 Auto-flagged sync: ${flagResult.pulled} pulled, ${flagResult.pushed} pushed`
              );
            }
          } catch (e) {
            this.clearProgress();
            console.error("[Auto Flagged Sync]", e);
            new Notice("❌ Flagged auto-sync failed. Check console.");
          }
        }
      }

      if (this.settings.rolloverOnStartup) {
        try {
          const result = await rolloverTasks(this.app.vault, this.settings);
          if (result.count > 0) {
            new Notice(`🔄 Auto-rollover: ${result.count} task(s) moved to today.`);
          }
        } catch (e) {
          console.error("[Auto Task Rollover]", e);
        }
      }
    });
  }

  onunload() {
    // nothing to tear down
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
