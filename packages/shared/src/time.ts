// Timezone-safe time resolution for spoken time phrases (spec/04 "Time policy").
//
// "this morning" is resolved against the caregiver's timezone and session date, and the original
// phrase is preserved in `source_text` together with the reduced precision.

import type { TimePrecision, TimeStatus } from "./vocab.ts";

export type WallClock = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

export function wallClockInTimeZone(date: Date, timeZone: string): WallClock & { second: number } {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number.parseInt(part.value, 10) : 0;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24, // some engines report midnight as 24
    minute: read("minute"),
    second: read("second"),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const wall = wallClockInTimeZone(date, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - date.getTime();
}

// Converts a wall-clock time in `timeZone` to the matching UTC instant. Two passes keep the result
// correct across daylight-saving transitions.
export function zonedTimeToUtc(wall: WallClock, timeZone: string): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const firstOffset = offsetMs(new Date(guess), timeZone);
  let timestamp = guess - firstOffset;
  const secondOffset = offsetMs(new Date(timestamp), timeZone);
  if (secondOffset !== firstOffset) {
    timestamp = guess - secondOffset;
  }
  return new Date(timestamp);
}

export function addDays(wall: WallClock, days: number): WallClock {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days, wall.hour, wall.minute));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  };
}

export type TimePhrase = {
  phrase: string;
  precision: TimePrecision;
  status: TimeStatus;
  dayOffset: number;
  // -1 means "the moment the caregiver submitted the report".
  hour: number;
  minute: number;
};

// Longest phrases are matched first so "yesterday morning" wins over "yesterday".
export const TIME_PHRASES: TimePhrase[] = [
  { phrase: "yesterday morning", precision: "morning", status: "relative_resolved", dayOffset: -1, hour: 8, minute: 0 },
  { phrase: "yesterday afternoon", precision: "afternoon", status: "relative_resolved", dayOffset: -1, hour: 14, minute: 0 },
  { phrase: "yesterday evening", precision: "evening", status: "relative_resolved", dayOffset: -1, hour: 19, minute: 0 },
  { phrase: "this morning", precision: "morning", status: "relative_resolved", dayOffset: 0, hour: 8, minute: 0 },
  { phrase: "this afternoon", precision: "afternoon", status: "relative_resolved", dayOffset: 0, hour: 14, minute: 0 },
  { phrase: "this evening", precision: "evening", status: "relative_resolved", dayOffset: 0, hour: 19, minute: 0 },
  { phrase: "last night", precision: "evening", status: "relative_resolved", dayOffset: -1, hour: 22, minute: 0 },
  { phrase: "just now", precision: "exact", status: "relative_resolved", dayOffset: 0, hour: -1, minute: -1 },
  { phrase: "right now", precision: "exact", status: "relative_resolved", dayOffset: 0, hour: -1, minute: -1 },
  { phrase: "yesterday", precision: "day", status: "relative_resolved", dayOffset: -1, hour: 12, minute: 0 },
  { phrase: "tonight", precision: "evening", status: "relative_resolved", dayOffset: 0, hour: 21, minute: 0 },
  { phrase: "today", precision: "day", status: "relative_resolved", dayOffset: 0, hour: 12, minute: 0 },
];

export type ResolvedTimePhrase = {
  observed_at: string;
  precision: TimePrecision;
  status: TimeStatus;
  source_text: string;
};

export function findTimePhrase(text: string): TimePhrase | null {
  const haystack = text.toLowerCase();
  const ordered = [...TIME_PHRASES].sort((a, b) => b.phrase.length - a.phrase.length);
  for (const candidate of ordered) {
    const index = haystack.indexOf(candidate.phrase);
    if (index === -1) continue;
    // Require word boundaries so "today" does not match inside another word.
    const before = index === 0 ? " " : haystack[index - 1];
    const afterIndex = index + candidate.phrase.length;
    const after = afterIndex >= haystack.length ? " " : haystack[afterIndex];
    if (!/[\s,.;:!?]/.test(before) || !/[\s,.;:!?]/.test(after)) continue;
    return candidate;
  }
  return null;
}

export function resolveTimePhrase(phrase: TimePhrase, now: Date, timeZone: string): ResolvedTimePhrase {
  if (phrase.hour === -1) {
    return {
      observed_at: now.toISOString(),
      precision: "exact",
      status: "relative_resolved",
      source_text: phrase.phrase,
    };
  }
  const today = wallClockInTimeZone(now, timeZone);
  const target = addDays({ ...today, hour: phrase.hour, minute: phrase.minute }, phrase.dayOffset);
  return {
    observed_at: zonedTimeToUtc(target, timeZone).toISOString(),
    precision: phrase.precision,
    status: phrase.status,
    source_text: phrase.phrase,
  };
}

// The precision that matches a caregiver phrase, used when a time arrives through a tool call
// rather than through the local extractor.
export function precisionForSourceText(sourceText: string | null | undefined): TimePrecision {
  if (!sourceText) return "exact";
  return findTimePhrase(sourceText)?.precision ?? "exact";
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function formatInstant(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

