#!/usr/bin/env swift
//
// calendar-cli — A fast, JSON-emitting CLI for reading macOS Calendar data.
//
// Uses EventKit to query the local calendar store (iCloud, Google, Exchange,
// subscribed calendars, etc.) without launching Calendar.app.
//
// Usage:
//   calendar-cli calendars
//   calendar-cli events today
//   calendar-cli events date 2026-03-20
//   calendar-cli events range 2026-03-18 2026-03-21
//   calendar-cli events search "standup"
//   calendar-cli events search "standup" --from 2026-03-01 --to 2026-03-31
//
// All output is JSON.  Errors are printed to stderr as JSON:
//   { "error": "message" }
//

import EventKit
import Foundation

// MARK: - JSON helpers

/// Encode a value to a compact JSON string.
func jsonString(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          let str = String(data: data, encoding: .utf8) else {
        return "null"
    }
    return str
}

/// Print a JSON object to stdout and exit with code 0.
func succeed(_ value: Any) -> Never {
    print(jsonString(value))
    exit(0)
}

/// Print a JSON error to stderr and exit with the given code.
func fail(_ message: String, code: Int32 = 1) -> Never {
    let errObj: [String: Any] = ["error": message]
    if let data = try? JSONSerialization.data(withJSONObject: errObj, options: []),
       let str = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write(str.data(using: .utf8)!)
        FileHandle.standardError.write("\n".data(using: .utf8)!)
    }
    exit(code)
}

// MARK: - Date helpers

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withFullDate, .withTime, .withColonSeparatorInTime]
    return f
}()

let dayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

/// Parse a date string in yyyy-MM-dd format, returning start-of-day in local timezone.
func parseDate(_ str: String) -> Date? {
    return dayFormatter.date(from: str)
}

/// Format a Date as ISO 8601 string.
func formatISO(_ date: Date) -> String {
    return isoFormatter.string(from: date)
}

// MARK: - Participant status mapping

func participantStatusString(_ status: EKParticipantStatus) -> String {
    switch status {
    case .accepted:    return "accepted"
    case .declined:    return "declined"
    case .tentative:   return "tentative"
    case .pending:     return "pending"
    case .delegated:   return "delegated"
    case .completed:   return "completed"
    case .inProcess:   return "in-process"
    default:           return "unknown"
    }
}

// MARK: - Event serialisation

func serialiseEvent(_ event: EKEvent) -> [String: Any] {
    var dict: [String: Any] = [
        "title": event.title ?? "(no title)",
        "start": formatISO(event.startDate),
        "end": formatISO(event.endDate),
        "allDay": event.isAllDay,
        "calendar": event.calendar.title,
        "calendarSource": event.calendar.source.title,
    ]

    if let loc = event.location, !loc.isEmpty {
        dict["location"] = loc
    }
    if let notes = event.notes, !notes.isEmpty {
        dict["notes"] = notes
    }
    if let url = event.url {
        dict["url"] = url.absoluteString
    }
    if event.hasRecurrenceRules, let rules = event.recurrenceRules, !rules.isEmpty {
        dict["recurring"] = true
    }
    if let organizer = event.organizer {
        var org: [String: Any] = [:]
        if let name = organizer.name { org["name"] = name }
        org["email"] = organizer.url.absoluteString
            .replacingOccurrences(of: "mailto:", with: "")
        dict["organizer"] = org
    }
    if let attendees = event.attendees, !attendees.isEmpty {
        dict["attendees"] = attendees.map { att -> [String: Any] in
            var a: [String: Any] = [
                "status": participantStatusString(att.participantStatus),
            ]
            if let name = att.name { a["name"] = name }
            let email = att.url.absoluteString
                .replacingOccurrences(of: "mailto:", with: "")
            a["email"] = email
            return a
        }
    }

    return dict
}

// MARK: - Calendar serialisation

func serialiseCalendar(_ cal: EKCalendar) -> [String: Any] {
    return [
        "title": cal.title,
        "source": cal.source.title,
        "type": calendarTypeString(cal.type),
        "color": cal.cgColor.flatMap { colorHex($0) } ?? "",
        "immutable": !cal.allowsContentModifications,
    ]
}

func calendarTypeString(_ type: EKCalendarType) -> String {
    switch type {
    case .local:        return "local"
    case .calDAV:       return "caldav"
    case .exchange:     return "exchange"
    case .subscription: return "subscription"
    case .birthday:     return "birthday"
    @unknown default:   return "unknown"
    }
}

func colorHex(_ cgColor: CGColor) -> String? {
    guard let components = cgColor.components, components.count >= 3 else { return nil }
    let r = Int(components[0] * 255)
    let g = Int(components[1] * 255)
    let b = Int(components[2] * 255)
    return String(format: "#%02x%02x%02x", r, g, b)
}

// MARK: - EventKit access

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)

func requestAccess(completion: @escaping () -> Void) {
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { granted, error in
            if !granted {
                fail("Calendar access denied. Grant permission in System Settings → Privacy & Security → Calendars. Error: \(error?.localizedDescription ?? "none")")
            }
            completion()
        }
    } else {
        store.requestAccess(to: .event) { granted, error in
            if !granted {
                fail("Calendar access denied. Grant permission in System Settings → Privacy & Security → Calendars. Error: \(error?.localizedDescription ?? "none")")
            }
            completion()
        }
    }
}

// MARK: - Commands

func listCalendars() {
    let calendars = store.calendars(for: .event)
    let result = calendars.map { serialiseCalendar($0) }
    succeed(result)
}

func getEvents(start: Date, end: Date, calendars: [EKCalendar]? = nil) {
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
    let events = store.events(matching: predicate)

    let sorted = events.sorted { $0.startDate < $1.startDate }
    let result = sorted.map { serialiseEvent($0) }
    succeed(result)
}

func searchEvents(query: String, start: Date, end: Date) {
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let events = store.events(matching: predicate)

    let lowerQuery = query.lowercased()
    let matched = events.filter { event in
        if let title = event.title, title.lowercased().contains(lowerQuery) { return true }
        if let notes = event.notes, notes.lowercased().contains(lowerQuery) { return true }
        if let location = event.location, location.lowercased().contains(lowerQuery) { return true }
        return false
    }

    let sorted = matched.sorted { $0.startDate < $1.startDate }
    let result = sorted.map { serialiseEvent($0) }
    succeed(result)
}

// MARK: - Argument parsing

func printUsage() -> Never {
    let usage = """
    Usage: calendar-cli <command> [args...]

    Commands:
      calendars                                     List all calendars
      events today                                  Events occurring today
      events tomorrow                               Events occurring tomorrow
      events date <yyyy-MM-dd>                      Events on a specific date
      events range <yyyy-MM-dd> <yyyy-MM-dd>        Events in a date range (inclusive)
      events search <query>                         Search events by title/notes/location
                    [--from <yyyy-MM-dd>]            (default: 30 days ago)
                    [--to <yyyy-MM-dd>]              (default: 30 days from now)

    All output is JSON.
    """
    FileHandle.standardError.write(usage.data(using: .utf8)!)
    exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())

if args.isEmpty {
    printUsage()
}

// Helper to find a flag value: --flag value
func flagValue(_ flag: String, in args: [String]) -> String? {
    guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

requestAccess {
    let cal = Calendar.current

    switch args[0] {
    case "calendars":
        listCalendars()

    case "events":
        if args.count < 2 { printUsage() }

        switch args[1] {
        case "today":
            let start = cal.startOfDay(for: Date())
            let end = cal.date(byAdding: .day, value: 1, to: start)!
            getEvents(start: start, end: end)

        case "tomorrow":
            let tomorrow = cal.date(byAdding: .day, value: 1, to: Date())!
            let start = cal.startOfDay(for: tomorrow)
            let end = cal.date(byAdding: .day, value: 1, to: start)!
            getEvents(start: start, end: end)

        case "date":
            if args.count < 3 { fail("Missing date. Usage: calendar-cli events date <yyyy-MM-dd>") }
            guard let date = parseDate(args[2]) else {
                fail("Invalid date format: '\(args[2])'. Expected yyyy-MM-dd.")
            }
            let start = cal.startOfDay(for: date)
            let end = cal.date(byAdding: .day, value: 1, to: start)!
            getEvents(start: start, end: end)

        case "range":
            if args.count < 4 { fail("Missing dates. Usage: calendar-cli events range <start> <end>") }
            guard let startDate = parseDate(args[2]) else {
                fail("Invalid start date: '\(args[2])'. Expected yyyy-MM-dd.")
            }
            guard let endDate = parseDate(args[3]) else {
                fail("Invalid end date: '\(args[3])'. Expected yyyy-MM-dd.")
            }
            let start = cal.startOfDay(for: startDate)
            // End is inclusive — add one day
            let end = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: endDate))!
            if end <= start { fail("End date must be after start date.") }
            getEvents(start: start, end: end)

        case "search":
            if args.count < 3 { fail("Missing query. Usage: calendar-cli events search <query> [--from <date>] [--to <date>]") }
            let query = args[2]
            let fromStr = flagValue("--from", in: args)
            let toStr = flagValue("--to", in: args)

            let start: Date
            if let fromStr = fromStr {
                guard let d = parseDate(fromStr) else {
                    fail("Invalid --from date: '\(fromStr)'. Expected yyyy-MM-dd.")
                }
                start = cal.startOfDay(for: d)
            } else {
                start = cal.date(byAdding: .day, value: -30, to: Date())!
            }

            let end: Date
            if let toStr = toStr {
                guard let d = parseDate(toStr) else {
                    fail("Invalid --to date: '\(toStr)'. Expected yyyy-MM-dd.")
                }
                end = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: d))!
            } else {
                end = cal.date(byAdding: .day, value: 30, to: Date())!
            }

            if end <= start { fail("--to must be after --from.") }
            searchEvents(query: query, start: start, end: end)

        default:
            fail("Unknown events subcommand: '\(args[1])'. Expected: today, tomorrow, date, range, search.")
        }

    default:
        fail("Unknown command: '\(args[0])'. Expected: calendars, events.")
    }
}

semaphore.wait()
