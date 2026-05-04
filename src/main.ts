import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, SettingsTab } from "./settings";
import { syncReminders, getRemindersLists } from "./reminders";
import { rolloverTasks } from "./rollover";
import type { PluginSettings } from "./settings";

export default class RemindersRolloverPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    // ── Settings tab ──
    this.addSettingTab(new SettingsTab(this.app, this));

    // ── Commands ──

    this.addCommand({
      id: "sync-reminders",
      name: "Sync Apple Reminders",
      callback: async () => {
        new Notice("⏳ Syncing Apple Reminders…");
        try {
          const result = await syncReminders(this.app.vault, this.settings);
          new Notice(
            `✅ Reminders sync complete — ${result.pulled} pulled, ${result.pushed} pushed, ${result.created} created`
          );
        } catch (e) {
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
          const lists = await getRemindersLists();
          new Notice(`📋 Reminders lists:\n${lists.join("\n")}`, 8000);
        } catch (e) {
          new Notice("❌ Could not read Reminders lists. Is Reminders.app running?");
        }
      },
    });

    // ── Startup hooks ──
    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.autoSyncOnStartup) {
        try {
          const result = await syncReminders(this.app.vault, this.settings);
          if (result.pulled + result.pushed + result.created > 0) {
            new Notice(
              `🔄 Auto-sync: ${result.pulled} pulled, ${result.pushed} pushed, ${result.created} created`
            );
          }
        } catch (e) {
          console.error("[Auto Reminders Sync]", e);
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
