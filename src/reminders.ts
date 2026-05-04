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
  priority: number; // 0 = none, 1 = high, 5 = medium, 9 = low
  listName: string;
}

// ─── JXA script runners ─────────────────────────────────────────

/** Run a JXA script and return parsed JSON */
function runJxa<T>(script: string): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`osascript failed: ${stderr || err.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as T);
        } catch {
          reject(new Error(`Failed to parse JXA output: ${stdout}`));
        }
      }
    );
  });
}

/** Run a JXA script that returns nothing meaningful */
function runJxaVoid(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`osascript failed: ${stderr || err.message}`));
          return;
        }
        resolve();
      }
    );
  });
}

// ─── Apple Reminders API ─────────────────────────────────────────

/** Get all reminder list names */
export async function getRemindersLists(): Promise<string[]> {
  const script = `
    const app = Application("Reminders");
    const lists = app.lists();
    JSON.stringify(lists.map(l => l.name()));
  `;
  return runJxa<string[]>(script);
}

/** Fetch all reminders from a named list */
export async function getReminders(listName: string): Promise<AppleReminder[]> {
  const escaped = listName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
    const app = Application("Reminders");
    const list = app.lists.byName("${escaped}");
    const rems = list.reminders();
    JSON.stringify(rems.map(r => ({
      id: r.id(),
      name: r.name(),
      completed: r.completed(),
      flagged: r.flagged(),
      dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
      notes: r.body() || null,
      priority: r.priority(),
      listName: "${escaped}"
    })));
  `;
  return runJxa<AppleReminder[]>(script);
}

/** Fetch all flagged reminders across every list */
export async function getFlaggedReminders(): Promise<AppleReminder[]> {
  const script = `
    const app = Application("Reminders");
    const results = [];
    const lists = app.lists();
    for (const list of lists) {
      const listName = list.name();
      const rems = list.reminders();
      for (const r of rems) {
        if (r.flagged()) {
          results.push({
            id: r.id(),
            name: r.name(),
            completed: r.completed(),
            flagged: true,
            dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
            notes: r.body() || null,
            priority: r.priority(),
            listName: listName
          });
        }
      }
    }
    JSON.stringify(results);
  `;
  return runJxa<AppleReminder[]>(script);
}

/** Create a new reminder in the given list */
export async function createReminder(
  listName: string,
  name: string,
  notes?: string
): Promise<void> {
  const escList = listName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escNotes = (notes || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
    const app = Application("Reminders");
    const list = app.lists.byName("${escList}");
    const props = { name: "${escName}", body: "${escNotes}" };
    const rem = app.Reminder(props);
    list.reminders.push(rem);
    "ok";
  `;
  await runJxaVoid(script);
}

/** Mark a reminder as completed or not */
export async function setReminderCompleted(
  reminderId: string,
  completed: boolean
): Promise<void> {
  const escaped = reminderId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
    const app = Application("Reminders");
    const lists = app.lists();
    for (const list of lists) {
      const rems = list.reminders();
      for (const r of rems) {
        if (r.id() === "${escaped}") {
          r.completed = ${completed};
          break;
        }
      }
    }
    "ok";
  `;
  await runJxaVoid(script);
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
  settings: PluginSettings
): Promise<{ pulled: number; pushed: number; created: number }> {
  const { remindersListName, syncNotePath, syncTagPrefix } = settings;

  // 1. Fetch current reminders from Apple
  let appleReminders: AppleReminder[];
  try {
    appleReminders = await getReminders(remindersListName);
  } catch (e) {
    new Notice(`❌ Could not read Reminders list "${remindersListName}". Is Reminders running?`);
    throw e;
  }

  // 2. Read or create the sync note
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

  // 3. Pull: reminders that aren't yet in the note
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

  // 4. Push: task checkbox changes → Apple Reminders
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

  // 5. Create: tasks with the sync tag but no reminder ID → new reminders
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

  // If new reminders were created, re-pull to capture their IDs
  if (created > 0) {
    const updated = await getReminders(remindersListName);
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

  // 6. Write back
  await vault.modify(tfile, content);

  return { pulled, pushed, created };
}

/**
 * Sync flagged reminders from ALL lists into a dedicated note.
 * Pull-only + push completion status back.
 * Each task shows which list it came from.
 */
export async function syncFlaggedReminders(
  vault: Vault,
  settings: PluginSettings
): Promise<{ pulled: number; pushed: number }> {
  const { flaggedNotePath, syncTagPrefix } = settings;

  // 1. Fetch flagged reminders across all lists
  let flagged: AppleReminder[];
  try {
    flagged = await getFlaggedReminders();
  } catch (e) {
    new Notice("❌ Could not read flagged reminders. Is Reminders running?");
    throw e;
  }

  // 2. Read or create the flagged note
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

  // 3. Pull: flagged reminders not yet in the note
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

  // 4. Push: checkbox changes back to Apple Reminders
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

  // 5. Write back
  await vault.modify(tfile, content);

  return { pulled, pushed };
}
