import { execFile } from "child_process";
import { Notice, TFile, Vault } from "obsidian";
import type { PluginSettings } from "./settings";

// ─── Types ───────────────────────────────────────────────────────
export interface AppleReminder {
  id: string;
  name: string;
  completed: boolean;
  flagged: boolean;
  dueDate: string | null;
  notes: string | null;
  priority: number;
  listName: string;
}

export interface ListInfo {
  id: string;
  name: string;
  count: number;
  account: string;
}

export type ProgressFn = (message: string) => void;

// ─── Swift helper runner ─────────────────────────────────────────

const TIMEOUT_MS = 60_000;

let _helperPath: string | null = null;

/** Set the path to reminders-helper.swift (called from main.ts on load) */
export function setHelperPath(path: string) {
  _helperPath = path;
}

/** Run the Swift helper with given args and return parsed JSON */
function runHelper<T>(args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!_helperPath) {
      reject(new Error("Helper path not set. Is the plugin installed correctly?"));
      return;
    }
    execFile(
      "/usr/bin/xcrun",
      ["swift", _helperPath, ...args],
      { maxBuffer: 10 * 1024 * 1024, timeout: TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (err as any).killed
            ? `Swift helper timed out after ${TIMEOUT_MS / 1000}s`
            : `Swift helper failed: ${stderr || err.message}`;
          reject(new Error(msg));
          return;
        }
        if (stderr && stderr.trim().length > 0) {
          console.warn("[Reminders Helper]", stderr.trim());
        }
        try {
          resolve(JSON.parse(stdout.trim()) as T);
        } catch {
          reject(new Error(`Failed to parse helper output: ${stdout.substring(0, 200)}`));
        }
      }
    );
  });
}

// ─── Apple Reminders API (via Swift EventKit) ────────────────────

/** Get all reminder list names (including grouped/nested ones) */
export async function getRemindersLists(): Promise<string[]> {
  return runHelper<string[]>(["list-lists-fast"]);
}

/** Get detailed list info (with counts) */
export async function getRemindersListsDetailed(): Promise<ListInfo[]> {
  return runHelper<ListInfo[]>(["list-lists"]);
}

/** Fetch reminders from a named list */
export async function getReminders(
  listName: string,
  skipCompleted = false
): Promise<AppleReminder[]> {
  const args = ["get-reminders", listName];
  if (skipCompleted) args.push("--skip-completed");
  return runHelper<AppleReminder[]>(args);
}

/** Fetch all flagged reminders across every list */
export async function getFlaggedReminders(
  onProgress?: ProgressFn,
  skipCompleted = false
): Promise<AppleReminder[]> {
  if (onProgress) onProgress("🔍 Scanning all lists for flagged items…");
  const args = ["get-flagged"];
  if (skipCompleted) args.push("--skip-completed");
  return runHelper<AppleReminder[]>(args);
}

/** Create a new reminder in the given list */
export async function createReminder(
  listName: string,
  name: string,
  notes?: string
): Promise<void> {
  const args = ["create", listName, name];
  if (notes) args.push(notes);
  await runHelper<{ ok: boolean }>(args);
}

/** Mark a reminder as completed or not */
export async function setReminderCompleted(
  reminderId: string,
  completed: boolean
): Promise<void> {
  await runHelper<{ ok: boolean }>(["complete", reminderId, String(completed)]);
}

// ─── Sync logic ──────────────────────────────────────────────────

const TASK_REGEX = /^- \[([ xX])\] (.+)$/;
const ID_COMMENT_REGEX = /%%rid:(.+?)%%/;

interface ParsedTask {
  line: string;
  checked: boolean;
  text: string;
  reminderId: string | null;
}

function parseTasks(content: string): ParsedTask[] {
  return content.split("\n").reduce<ParsedTask[]>((acc, line) => {
    const m = line.match(TASK_REGEX);
    if (!m) return acc;
    const idMatch = line.match(ID_COMMENT_REGEX);
    acc.push({
      line,
      checked: m[1] !== " ",
      text: m[2].replace(ID_COMMENT_REGEX, "").trim(),
      reminderId: idMatch ? idMatch[1] : null,
    });
    return acc;
  }, []);
}

function stripTagAndId(text: string, tagPrefix: string): string {
  return text
    .replace(new RegExp(`\\s*${tagPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), " ")
    .replace(ID_COMMENT_REGEX, "")
    .trim();
}

/** Parse comma-separated list names from settings */
function parseListNames(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Sync a single list into a note (or section of a note).
 * Returns { pulled, pushed, created } counts.
 */
async function syncSingleList(
  vault: Vault,
  listName: string,
  notePath: string,
  settings: PluginSettings,
  heading: string | null,
  onProgress?: ProgressFn
): Promise<{ pulled: number; pushed: number; created: number }> {
  const { syncTagPrefix } = settings;

  if (onProgress) onProgress(`⏳ Reading list "${listName}"…`);
  let appleReminders: AppleReminder[];
  try {
    appleReminders = await getReminders(listName, settings.skipCompleted);
  } catch (e) {
    console.error(`Could not read list "${listName}":`, e);
    new Notice(`❌ Could not read list "${listName}". Check console.`);
    return { pulled: 0, pushed: 0, created: 0 };
  }

  if (onProgress) onProgress(`📋 ${listName}: ${appleReminders.length} reminder(s)…`);

  // Read or create the note
  let file = vault.getAbstractFileByPath(notePath);
  if (!file || !(file instanceof TFile)) {
    const title = heading ? `# ${heading}\n\n` : `# ${listName}\n\n`;
    // Ensure parent folder exists
    const folder = notePath.substring(0, notePath.lastIndexOf("/"));
    if (folder && !vault.getAbstractFileByPath(folder)) {
      await vault.createFolder(folder);
    }
    await vault.create(notePath, title);
    file = vault.getAbstractFileByPath(notePath);
  }
  const tfile = file as TFile;
  let content = await vault.read(tfile);

  // If using headings in a combined note, find or create the section
  let sectionStart = 0;
  let sectionEnd = content.length;
  if (heading) {
    const headingLine = `## ${listName}`;
    const headingIdx = content.indexOf(headingLine);
    if (headingIdx === -1) {
      // Add new section at the end
      content = content.trimEnd() + `\n\n${headingLine}\n`;
      sectionStart = content.length;
      sectionEnd = content.length;
    } else {
      sectionStart = headingIdx + headingLine.length + 1;
      // Find next ## heading or end of file
      const nextHeading = content.indexOf("\n## ", sectionStart);
      sectionEnd = nextHeading === -1 ? content.length : nextHeading;
    }
  }

  const existingTasks = parseTasks(content);
  const trackedIds = new Set(existingTasks.filter((t) => t.reminderId).map((t) => t.reminderId));

  let pulled = 0;
  let pushed = 0;
  let created = 0;

  // Pull: reminders not yet in the note
  const newLines: string[] = [];
  for (const rem of appleReminders) {
    if (trackedIds.has(rem.id)) continue;
    const check = rem.completed ? "x" : " ";
    const line = `- [${check}] ${rem.name} ${syncTagPrefix} %%rid:${rem.id}%%`;
    newLines.push(line);
    pulled++;
  }

  if (newLines.length > 0) {
    if (heading) {
      // Insert at the end of this section
      const before = content.substring(0, sectionEnd);
      const after = content.substring(sectionEnd);
      content = before.trimEnd() + "\n" + newLines.join("\n") + "\n" + after;
    } else {
      content = content.trimEnd() + "\n" + newLines.join("\n") + "\n";
    }
  }

  // Push: checkbox changes → Apple Reminders
  const remMap = new Map(appleReminders.map((r) => [r.id, r]));
  for (const task of existingTasks) {
    if (!task.reminderId) continue;
    const rem = remMap.get(task.reminderId);
    if (!rem) continue;
    if (task.checked !== rem.completed) {
      await setReminderCompleted(task.reminderId, task.checked);
      pushed++;
    }
  }

  // Create: tasks with sync tag but no ID → new reminders
  for (const task of existingTasks) {
    if (task.reminderId) continue;
    if (!task.text.includes(syncTagPrefix)) continue;
    const cleanName = stripTagAndId(task.text, syncTagPrefix);
    try {
      await createReminder(listName, cleanName);
      created++;
    } catch (e) {
      console.error("Failed to create reminder:", e);
    }
  }

  if (created > 0) {
    const updated = await getReminders(listName, settings.skipCompleted);
    const refreshedTasks = parseTasks(content);
    for (const task of refreshedTasks) {
      if (task.reminderId || !task.text.includes(syncTagPrefix)) continue;
      const cleanName = stripTagAndId(task.text, syncTagPrefix);
      const match = updated.find(
        (r) => r.name === cleanName && !trackedIds.has(r.id)
      );
      if (match) {
        const oldLine = task.line;
        const newLine = oldLine.replace(/$/, ` %%rid:${match.id}%%`);
        content = content.replace(oldLine, newLine);
        trackedIds.add(match.id);
      }
    }
  }

  await vault.modify(tfile, content);
  return { pulled, pushed, created };
}

/**
 * Multi-list bidirectional sync.
 * Supports comma-separated list names.
 * Two modes: combined note (with ## headings per list) or separate notes.
 */
export async function syncReminders(
  vault: Vault,
  settings: PluginSettings,
  onProgress?: ProgressFn
): Promise<{ pulled: number; pushed: number; created: number }> {
  const listNames = parseListNames(settings.remindersListName);
  if (listNames.length === 0) {
    new Notice("⚠️ No list names configured. Set them in plugin settings.");
    return { pulled: 0, pushed: 0, created: 0 };
  }

  let totalPulled = 0;
  let totalPushed = 0;
  let totalCreated = 0;

  if (onProgress) onProgress(`⏳ Syncing ${listNames.length} list(s)…`);

  for (let i = 0; i < listNames.length; i++) {
    const listName = listNames[i];
    if (onProgress) {
      onProgress(`📋 Syncing "${listName}" (${i + 1}/${listNames.length})…`);
    }

    let notePath: string;
    let heading: string | null;

    if (settings.separateNotes) {
      // Separate notes: syncNotePath is a folder, each list gets its own file
      const folder = settings.syncNotePath.replace(/\.md$/i, "").replace(/\/+$/, "");
      notePath = `${folder}/${listName}.md`;
      heading = null;
    } else if (listNames.length === 1) {
      // Single list: use syncNotePath directly, no heading needed
      notePath = settings.syncNotePath;
      heading = null;
    } else {
      // Multiple lists in one note: use ## headings
      notePath = settings.syncNotePath;
      heading = listName;
    }

    const result = await syncSingleList(vault, listName, notePath, settings, heading, onProgress);
    totalPulled += result.pulled;
    totalPushed += result.pushed;
    totalCreated += result.created;
  }

  return { pulled: totalPulled, pushed: totalPushed, created: totalCreated };
}

/**
 * Sync flagged reminders from ALL lists into a dedicated note.
 */
export async function syncFlaggedReminders(
  vault: Vault,
  settings: PluginSettings,
  onProgress?: ProgressFn
): Promise<{ pulled: number; pushed: number }> {
  const { flaggedNotePath, syncTagPrefix } = settings;

  if (onProgress) onProgress("⏳ Scanning all lists for flagged reminders…");
  let flagged: AppleReminder[];
  try {
    flagged = await getFlaggedReminders(onProgress, settings.skipCompleted);
  } catch (e) {
    new Notice("❌ Could not read flagged reminders. Check console.");
    throw e;
  }

  if (onProgress) onProgress(`📝 Found ${flagged.length} flagged reminder(s), writing…`);

  let file = vault.getAbstractFileByPath(flaggedNotePath);
  if (!file || !(file instanceof TFile)) {
    await vault.create(flaggedNotePath, "# Flagged Reminders\n\n");
    file = vault.getAbstractFileByPath(flaggedNotePath);
  }
  const tfile = file as TFile;
  let content = await vault.read(tfile);

  const existingTasks = parseTasks(content);
  const trackedIds = new Set(existingTasks.filter((t) => t.reminderId).map((t) => t.reminderId));

  let pulled = 0;
  let pushed = 0;

  const newLines: string[] = [];
  for (const rem of flagged) {
    if (trackedIds.has(rem.id)) continue;
    const check = rem.completed ? "x" : " ";
    const line = `- [${check}] ${rem.name} (${rem.listName}) ${syncTagPrefix} %%rid:${rem.id}%%`;
    newLines.push(line);
    pulled++;
  }
  if (newLines.length > 0) {
    content = content.trimEnd() + "\n" + newLines.join("\n") + "\n";
  }

  if (onProgress && existingTasks.length > 0) onProgress("🔄 Pushing checkbox changes…");
  const remMap = new Map(flagged.map((r) => [r.id, r]));
  for (const task of existingTasks) {
    if (!task.reminderId) continue;
    const rem = remMap.get(task.reminderId);
    if (!rem) continue;
    if (task.checked !== rem.completed) {
      await setReminderCompleted(task.reminderId, task.checked);
      pushed++;
    }
  }

  await vault.modify(tfile, content);
  return { pulled, pushed };
}
