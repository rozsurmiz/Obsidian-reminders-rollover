import { moment, Notice, TFile, Vault } from "obsidian";
import type { PluginSettings } from "./settings";

// ─── Helpers ─────────────────────────────────────────────────────

const UNCHECKED_REGEX = /^(\s*)- \[ \] (.+)$/;

interface UncheckedTask {
  fullLine: string;
  indent: string;
  text: string;
}

function getNotePath(folder: string, filename: string): string {
  if (folder && folder.length > 0) {
    const clean = folder.replace(/^\/+|\/+$/g, "");
    return `${clean}/${filename}.md`;
  }
  return `${filename}.md`;
}

function extractUncheckedTasks(content: string): UncheckedTask[] {
  const tasks: UncheckedTask[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(UNCHECKED_REGEX);
    if (m) {
      tasks.push({ fullLine: line, indent: m[1], text: m[2] });
    }
  }
  return tasks;
}

// ─── Rollover ────────────────────────────────────────────────────

export async function rolloverTasks(
  vault: Vault,
  settings: PluginSettings
): Promise<{ count: number }> {
  const { dailyNoteFolder, dailyNoteFormat, rolloverHeading, deleteFromYesterday, rolloverPrefix } =
    settings;

  const today = moment();
  const yesterday = moment().subtract(1, "day");

  const yesterdayPath = getNotePath(dailyNoteFolder, yesterday.format(dailyNoteFormat));
  const todayPath = getNotePath(dailyNoteFolder, today.format(dailyNoteFormat));

  // 1. Read yesterday's note
  const yesterdayFile = vault.getAbstractFileByPath(yesterdayPath);
  if (!yesterdayFile || !(yesterdayFile instanceof TFile)) {
    // No yesterday note → nothing to roll over
    return { count: 0 };
  }

  const yesterdayContent = await vault.read(yesterdayFile);
  const unchecked = extractUncheckedTasks(yesterdayContent);

  if (unchecked.length === 0) {
    return { count: 0 };
  }

  // 2. Build the block to insert
  const prefix = rolloverPrefix || "";
  const taskLines = unchecked.map(
    (t) => `${t.indent}- [ ] ${prefix}${t.text}`
  );

  let block: string;
  if (rolloverHeading && rolloverHeading.trim().length > 0) {
    block = `\n## ${rolloverHeading}\n${taskLines.join("\n")}\n`;
  } else {
    block = `\n${taskLines.join("\n")}\n`;
  }

  // 3. Read or create today's note
  let todayFile = vault.getAbstractFileByPath(todayPath);
  if (!todayFile || !(todayFile instanceof TFile)) {
    // Create the daily note with a basic heading
    const initialContent = `# ${today.format(dailyNoteFormat)}\n`;
    await vault.create(todayPath, initialContent);
    todayFile = vault.getAbstractFileByPath(todayPath);
  }
  const tfile = todayFile as TFile;

  let todayContent = await vault.read(tfile);

  // Avoid duplicating if rollover already happened today
  if (rolloverHeading && todayContent.includes(`## ${rolloverHeading}`)) {
    new Notice("Task rollover already applied to today's note.");
    return { count: 0 };
  }

  // Check for duplicate tasks even without the heading
  const existingTasks = extractUncheckedTasks(todayContent);
  const existingTexts = new Set(existingTasks.map((t) => t.text));
  const newTasks = taskLines.filter((line) => {
    const m = line.match(UNCHECKED_REGEX);
    if (!m) return true;
    const text = m[2].replace(new RegExp(`^${escapeRegex(prefix)}`), "");
    return !existingTexts.has(text);
  });

  if (newTasks.length === 0) {
    new Notice("All tasks already present in today's note.");
    return { count: 0 };
  }

  // Re-build block with only genuinely new tasks
  if (rolloverHeading && rolloverHeading.trim().length > 0) {
    block = `\n## ${rolloverHeading}\n${newTasks.join("\n")}\n`;
  } else {
    block = `\n${newTasks.join("\n")}\n`;
  }

  todayContent = todayContent.trimEnd() + "\n" + block;
  await vault.modify(tfile, todayContent);

  // 4. Optionally clean up yesterday's note
  if (deleteFromYesterday) {
    let cleaned = yesterdayContent;
    for (const task of unchecked) {
      cleaned = cleaned.replace(task.fullLine + "\n", "");
      cleaned = cleaned.replace(task.fullLine, ""); // last line edge case
    }
    await vault.modify(yesterdayFile, cleaned);
  }

  return { count: newTasks.length };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
