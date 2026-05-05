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
      "/usr/bin/swift",
      [_helperPath, ...args],
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

/**
 * Full bidirectional sync:
 * 1. Pull reminders → create/update tasks in the sync note
 * 2. Push task checkbox changes → update reminder completion status
 * 3. New tasks in the sync note without a reminder ID → create in Apple Reminders
 */
export async function syncReminders(
  vault: Vault,
  settings: PluginSettings,
  onProgress?: ProgressFn
): Promise<{ pulled: number; pushed: number; created: number }> {
  const { remindersListName, syncNotePath, syncTagPrefix } = settings;

  if (onProgress) onProgress(`⏳ Reading list "${remindersListName}"…`);
  let appleReminders: AppleReminder[];
  try {
    appleReminders = await getReminders(remindersListName, settings.skipCompleted);
  } catch (e) {
    new Notice(`❌ Could not read list "${remindersListName}". Check console.`);
    throw e;
  }

  if (onProgress) onProgress(`📋 Found ${appleReminders.length} reminder(s), syncing…`);

  let file = vault.getAbstractFileByPath(syncNotePath);
  if (!file || !(file instanceof TFile)) {
    await vault.create(syncNotePath, `# ${remindersListName}\n\n`);
    file = vault.getAbstractFileByPath(syncNotePath);
  }
  const tfile = file as TFile;
  let content = await vault.read(tfile);

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
    content = content.trimEnd() + "\n" + newLines.join("\n") + "\n";
  }

  // Push: checkbox changes → Apple Reminders
  if (onProgress && existingTasks.length > 0) onProgress("🔄 Pushing checkbox changes…");
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
      await createReminder(remindersListName, cleanName);
      created++;
    } catch (e) {
      console.error("Failed to create reminder:", e);
    }
  }

  if (created > 0) {
    const updated = await getReminders(remindersListName, settings.skipCompleted);
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
