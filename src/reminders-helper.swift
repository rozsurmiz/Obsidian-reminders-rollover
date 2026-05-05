#!/usr/bin/env swift

import Foundation
import EventKit

// ─── CLI interface ───────────────────────────────────────────────
// Usage:
//   swift reminders-helper.swift list-lists
//   swift reminders-helper.swift get-reminders "ListName" [--skip-completed]
//   swift reminders-helper.swift get-flagged [--skip-completed]
//   swift reminders-helper.swift complete "reminderID" true|false

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: swift reminders-helper.swift <command> [args...]\n", stderr)
    exit(1)
}

let command = args[1]
let store = EKEventStore()

// ─── Request access synchronously ────────────────────────────────
let semaphore = DispatchSemaphore(value: 0)
var accessGranted = false

if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { granted, error in
        accessGranted = granted
        if let error = error {
            fputs("Access error: \(error.localizedDescription)\n", stderr)
        }
        semaphore.signal()
    }
} else {
    store.requestAccess(to: .reminder) { granted, error in
        accessGranted = granted
        if let error = error {
            fputs("Access error: \(error.localizedDescription)\n", stderr)
        }
        semaphore.signal()
    }
}
semaphore.wait()

guard accessGranted else {
    fputs("Reminders access denied. Grant access in System Settings → Privacy & Security → Reminders.\n", stderr)
    print("[]")
    exit(1)
}

// ─── Helpers ─────────────────────────────────────────────────────

struct ReminderJSON: Codable {
    let id: String
    let name: String
    let completed: Bool
    let flagged: Bool
    let dueDate: String?
    let notes: String?
    let priority: Int
    let listName: String
}

struct ListInfo: Codable {
    let id: String
    let name: String
    let count: Int
    let account: String
    let color: String?
}

func fetchReminders(from calendar: EKCalendar, skipCompleted: Bool) -> [ReminderJSON] {
    let predicate = store.predicateForReminders(in: [calendar])
    var results: [EKReminder] = []
    let fetchSemaphore = DispatchSemaphore(value: 0)

    store.fetchReminders(matching: predicate) { reminders in
        results = reminders ?? []
        fetchSemaphore.signal()
    }
    fetchSemaphore.wait()

    return results.compactMap { r in
        if skipCompleted && r.isCompleted { return nil }
        let dueDateStr: String?
        if let d = r.dueDateComponents?.date {
            let formatter = ISO8601DateFormatter()
            dueDateStr = formatter.string(from: d)
        } else {
            dueDateStr = nil
        }
        return ReminderJSON(
            id: r.calendarItemIdentifier,
            name: r.title ?? "(untitled)",
            completed: r.isCompleted,
            flagged: r.isFlagged,
            dueDate: dueDateStr,
            notes: r.notes,
            priority: r.priority,
            listName: calendar.title
        )
    }
}

func toJSON<T: Encodable>(_ value: T) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard let data = try? encoder.encode(value) else { return "[]" }
    return String(data: data, encoding: .utf8) ?? "[]"
}

// ─── Commands ────────────────────────────────────────────────────

switch command {

case "list-lists":
    let calendars = store.calendars(for: .reminder)
    let infos = calendars.map { cal -> ListInfo in
        // Count reminders
        let pred = store.predicateForReminders(in: [cal])
        var count = 0
        let s = DispatchSemaphore(value: 0)
        store.fetchReminders(matching: pred) { rems in
            count = rems?.count ?? 0
            s.signal()
        }
        s.wait()

        return ListInfo(
            id: cal.calendarIdentifier,
            name: cal.title,
            count: count,
            account: cal.source.title,
            color: nil
        )
    }
    print(toJSON(infos))

case "list-lists-fast":
    // Just names, no counting (faster)
    let calendars = store.calendars(for: .reminder)
    let names = calendars.map { $0.title }
    print(toJSON(names))

case "get-reminders":
    guard args.count >= 3 else {
        fputs("Usage: get-reminders \"ListName\" [--skip-completed]\n", stderr)
        exit(1)
    }
    let listName = args[2]
    let skipCompleted = args.contains("--skip-completed")

    let calendars = store.calendars(for: .reminder)
    guard let calendar = calendars.first(where: { $0.title == listName }) else {
        fputs("List not found: \(listName)\n", stderr)
        print("[]")
        exit(1)
    }

    let reminders = fetchReminders(from: calendar, skipCompleted: skipCompleted)
    print(toJSON(reminders))

case "get-flagged":
    let skipCompleted = args.contains("--skip-completed")
    let calendars = store.calendars(for: .reminder)
    var allFlagged: [ReminderJSON] = []

    for cal in calendars {
        let rems = fetchReminders(from: cal, skipCompleted: skipCompleted)
        allFlagged.append(contentsOf: rems.filter { $0.flagged })
    }
    print(toJSON(allFlagged))

case "get-group":
    // Get all reminders from lists belonging to a specific account/group
    guard args.count >= 3 else {
        fputs("Usage: get-group \"GroupOrAccountName\" [--skip-completed]\n", stderr)
        exit(1)
    }
    let groupName = args[2]
    let skipCompleted = args.contains("--skip-completed")
    let calendars = store.calendars(for: .reminder)

    // Try matching by source (account) name first, then by list title prefix
    let matchedCals = calendars.filter { $0.source.title == groupName }

    var allReminders: [ReminderJSON] = []
    for cal in (matchedCals.isEmpty ? calendars : matchedCals) {
        let rems = fetchReminders(from: cal, skipCompleted: skipCompleted)
        allReminders.append(contentsOf: rems)
    }
    print(toJSON(allReminders))

case "complete":
    guard args.count >= 4 else {
        fputs("Usage: complete \"reminderID\" true|false\n", stderr)
        exit(1)
    }
    let reminderId = args[2]
    let completed = args[3] == "true"

    let calendars = store.calendars(for: .reminder)
    let predicate = store.predicateForReminders(in: calendars)
    let fetchSem = DispatchSemaphore(value: 0)
    var found = false

    store.fetchReminders(matching: predicate) { reminders in
        if let rem = reminders?.first(where: { $0.calendarItemIdentifier == reminderId }) {
            rem.isCompleted = completed
            do {
                try store.save(rem, commit: true)
                found = true
            } catch {
                fputs("Failed to save: \(error.localizedDescription)\n", stderr)
            }
        }
        fetchSem.signal()
    }
    fetchSem.wait()

    print(found ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"Reminder not found\"}")

case "create":
    guard args.count >= 4 else {
        fputs("Usage: create \"ListName\" \"Title\" [\"Notes\"]\n", stderr)
        exit(1)
    }
    let listName = args[2]
    let title = args[3]
    let notes = args.count >= 5 ? args[4] : nil

    let calendars = store.calendars(for: .reminder)
    guard let calendar = calendars.first(where: { $0.title == listName }) else {
        fputs("List not found: \(listName)\n", stderr)
        exit(1)
    }

    let reminder = EKReminder(eventStore: store)
    reminder.title = title
    reminder.notes = notes
    reminder.calendar = calendar

    do {
        try store.save(reminder, commit: true)
        print("{\"ok\":true,\"id\":\"\(reminder.calendarItemIdentifier)\"}")
    } catch {
        fputs("Failed to create: \(error.localizedDescription)\n", stderr)
        print("{\"ok\":false}")
        exit(1)
    }

default:
    fputs("Unknown command: \(command)\n", stderr)
    fputs("Commands: list-lists, list-lists-fast, get-reminders, get-flagged, get-group, complete, create\n", stderr)
    exit(1)
}
