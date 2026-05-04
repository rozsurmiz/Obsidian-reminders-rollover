import { App, PluginSettingTab, Setting } from "obsidian";
import type RemindersRolloverPlugin from "./main";

// ─── Settings shape ──────────────────────────────────────────────
export interface PluginSettings {
  // Reminders sync
  remindersListName: string;         // which Apple Reminders list to sync
  syncTagPrefix: string;             // tag used to mark synced tasks, e.g. #reminders
  syncNotePath: string;              // note file where synced reminders live (relative to vault root)
  autoSyncOnStartup: boolean;

  // Flagged reminders
  syncFlagged: boolean;              // enable flagged reminders sync
  flaggedNotePath: string;           // note file for flagged reminders

  // Task rollover
  rolloverOnStartup: boolean;
  rolloverHeading: string;           // heading under which rolled tasks appear
  deleteFromYesterday: boolean;      // remove rolled tasks from yesterday's note
  rolloverPrefix: string;            // optional prefix for rolled-over tasks, e.g. "⏎ "
  dailyNoteFolder: string;           // folder where daily notes live (empty = vault root)
  dailyNoteFormat: string;           // moment.js date format
}

export const DEFAULT_SETTINGS: PluginSettings = {
  remindersListName: "Reminders",
  syncTagPrefix: "#reminders",
  syncNotePath: "Reminders.md",
  autoSyncOnStartup: false,

  syncFlagged: true,
  flaggedNotePath: "Flagged Reminders.md",

  rolloverOnStartup: true,
  rolloverHeading: "Rolled Over",
  deleteFromYesterday: false,
  rolloverPrefix: "",
  dailyNoteFolder: "",
  dailyNoteFormat: "YYYY-MM-DD",
};

// ─── Settings tab UI ─────────────────────────────────────────────
export class SettingsTab extends PluginSettingTab {
  plugin: RemindersRolloverPlugin;

  constructor(app: App, plugin: RemindersRolloverPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Apple Reminders section ──
    containerEl.createEl("h2", { text: "Apple Reminders Sync" });

    new Setting(containerEl)
      .setName("Reminders list name")
      .setDesc("The Apple Reminders list to sync with.")
      .addText((text) =>
        text
          .setPlaceholder("Reminders")
          .setValue(this.plugin.settings.remindersListName)
          .onChange(async (value) => {
            this.plugin.settings.remindersListName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync note path")
      .setDesc("Vault-relative path to the note that holds synced reminders (e.g. Reminders.md).")
      .addText((text) =>
        text
          .setPlaceholder("Reminders.md")
          .setValue(this.plugin.settings.syncNotePath)
          .onChange(async (value) => {
            this.plugin.settings.syncNotePath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync tag prefix")
      .setDesc("Tag added to synced tasks so the plugin can track them.")
      .addText((text) =>
        text
          .setPlaceholder("#reminders")
          .setValue(this.plugin.settings.syncTagPrefix)
          .onChange(async (value) => {
            this.plugin.settings.syncTagPrefix = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-sync on startup")
      .setDesc("Pull reminders automatically when Obsidian launches.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Flagged reminders section ──
    containerEl.createEl("h2", { text: "Flagged Reminders" });

    new Setting(containerEl)
      .setName("Sync flagged reminders")
      .setDesc("Pull flagged reminders from all lists into a dedicated note.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncFlagged)
          .onChange(async (value) => {
            this.plugin.settings.syncFlagged = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Flagged note path")
      .setDesc("Vault-relative path for flagged reminders (e.g. Flagged Reminders.md).")
      .addText((text) =>
        text
          .setPlaceholder("Flagged Reminders.md")
          .setValue(this.plugin.settings.flaggedNotePath)
          .onChange(async (value) => {
            this.plugin.settings.flaggedNotePath = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Task rollover section ──
    containerEl.createEl("h2", { text: "Daily Note Task Rollover" });

    new Setting(containerEl)
      .setName("Roll over on startup")
      .setDesc("Automatically move unchecked tasks from yesterday when Obsidian opens.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.rolloverOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.rolloverOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Heading for rolled-over tasks")
      .setDesc("Tasks are placed under this heading in today's note. Leave blank to append at the end.")
      .addText((text) =>
        text
          .setPlaceholder("Rolled Over")
          .setValue(this.plugin.settings.rolloverHeading)
          .onChange(async (value) => {
            this.plugin.settings.rolloverHeading = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remove from yesterday")
      .setDesc("Delete rolled-over tasks from yesterday's note (otherwise they stay as unchecked).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteFromYesterday)
          .onChange(async (value) => {
            this.plugin.settings.deleteFromYesterday = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Rollover prefix")
      .setDesc("Optional prefix prepended to each rolled task, e.g. ⏎ or 🔄 ")
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.rolloverPrefix)
          .onChange(async (value) => {
            this.plugin.settings.rolloverPrefix = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Daily notes folder")
      .setDesc("Folder where daily notes are stored (leave empty for vault root).")
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.dailyNoteFolder)
          .onChange(async (value) => {
            this.plugin.settings.dailyNoteFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Daily note date format")
      .setDesc("moment.js format string matching your daily note filenames.")
      .addText((text) =>
        text
          .setPlaceholder("YYYY-MM-DD")
          .setValue(this.plugin.settings.dailyNoteFormat)
          .onChange(async (value) => {
            this.plugin.settings.dailyNoteFormat = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
