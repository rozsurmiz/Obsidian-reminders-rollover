# Reminders Sync & Task Rollover — Obsidian Plugin

An Obsidian plugin that does two things:

1. **Apple Reminders ↔ Obsidian sync** — bidirectional sync between an Apple Reminders list and a designated note in your vault
2. **Daily note task rollover** — unchecked tasks from yesterday's daily note are automatically carried forward to today

> ⚠️ macOS only — Reminders sync uses `osascript` (JavaScript for Automation) to talk to Apple Reminders.

---

## Installation

### Option A: Manual install (recommended for development)

```bash
cd /path/to/your/vault/.obsidian/plugins/
git clone <this-repo> reminders-rollover
cd reminders-rollover
npm install
npm run build
```

Then restart Obsidian and enable the plugin under **Settings → Community plugins**.

### Option B: Copy the built file

1. Run `npm install && npm run build` in this directory
2. Copy these files into your vault at `.obsidian/plugins/reminders-rollover/`:
   - `main.js`
   - `manifest.json`
3. Restart Obsidian and enable the plugin

---

## Setup

### Apple Reminders Sync

1. Open **Settings → Reminders Sync & Task Rollover**
2. Set **Reminders list name** to the exact name of your Apple Reminders list (e.g. `Reminders`, `Groceries`, `Work`)
3. Set **Sync note path** — the vault-relative path to a Markdown note that will hold synced reminders (e.g. `Reminders.md`)
4. Optionally enable **Auto-sync on startup**

**How it works:**

- **Pull**: New reminders from Apple → new `- [ ]` tasks in your sync note, tagged with `#reminders` and an invisible ID comment `%%rid:...%%`
- **Push**: When you check/uncheck a task in Obsidian → the corresponding reminder is marked complete/incomplete in Apple Reminders
- **Create**: If you add a new task to the sync note with the `#reminders` tag (but no `%%rid:...%%`), syncing will create it in Apple Reminders

Run sync manually via **Command Palette → Sync Apple Reminders**, or let it run on startup.

### Daily Note Task Rollover

1. Set your **Daily notes folder** and **Date format** to match your Core Daily Notes settings
2. Optionally customize the **Heading** under which rolled-over tasks appear
3. Enable **Roll over on startup** for automatic rollover

Run manually via **Command Palette → Roll over yesterday's unchecked tasks**.

---

## Commands

| Command | Description |
|---------|-------------|
| `Sync Apple Reminders` | Pull/push/create reminders bidirectionally |
| `Roll over yesterday's unchecked tasks` | Move unchecked `- [ ]` items to today |
| `Show available Reminders lists` | Display all Apple Reminders lists (useful for finding the right list name) |

---

## macOS Permissions

The first time you sync, macOS will prompt you to grant Obsidian access to Reminders. You must allow this for the plugin to work. If you accidentally denied it, go to **System Settings → Privacy & Security → Reminders** and enable Obsidian.

---

## Example Workflow

**Daily note `2026-05-03.md`:**
```markdown
# 2026-05-03

## Tasks
- [x] Write weekly report
- [ ] Review PR #42
- [ ] Email supervisor about data pipeline
```

**After rollover, `2026-05-04.md` becomes:**
```markdown
# 2026-05-04

## Rolled Over
- [ ] Review PR #42
- [ ] Email supervisor about data pipeline
```

**Reminders sync note `Reminders.md`:**
```markdown
# Reminders

- [ ] Buy groceries #reminders %%rid:x-apple-reminder://ABC123%%
- [x] Schedule dentist #reminders %%rid:x-apple-reminder://DEF456%%
- [ ] Call bank #reminders
```
The third item has no `%%rid:...%%` yet — on next sync it will be created in Apple Reminders and the ID will be backfilled.

---

## Troubleshooting

- **"Could not read Reminders list"** — Make sure Reminders.app is installed and the list name matches exactly (case-sensitive)
- **No macOS permission prompt** — Try running `osascript -l JavaScript -e 'Application("Reminders").lists()'` in Terminal to trigger the prompt
- **Tasks not rolling over** — Verify your daily note folder and date format match exactly what the Core Daily Notes plugin uses
