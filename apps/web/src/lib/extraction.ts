export type MeasurementType = "blood_pressure" | "blood_glucose" | "temperature" | "heart_rate" | "spo2";
export type ObservationType = "symptom" | "pain" | "food" | "mood" | "sleep" | "free_text";
export type TimePrecision = "exact" | "morning" | "afternoon" | "evening" | "day" | "period" | "assumed" | "unknown";

export type ExtractedMeasurement = {
  type: MeasurementType;
  value: number | string | { systolic: number; diastolic: number };
  unit: string | null;
  confidence: number;
  source_text: string;
};

export type ExtractedObservation = {
  type: ObservationType;
  description: string;
  confidence: number;
  source_text: string;
};

export type UnresolvedIssue = {
  id: string;
  type: "missing_unit" | "ambiguous_value" | "observation_time_missing";
  measurement_type?: MeasurementType;
  message: string;
  question: string;
  source_text: string;
  blocking: true;
};

export type ExtractionResult = {
  measurements: ExtractedMeasurement[];
  observations: ExtractedObservation[];
  observation_time: string | null;
  observation_time_precision: TimePrecision;
  observation_time_source: string | null;
  unresolved_issues: UnresolvedIssue[];
};

type MatchValue = RegExpExecArray;

function textForMatch(transcript: string, match: MatchValue): string {
  const start = transcript.lastIndexOf(".", match.index) + 1;
  const previousQuestion = transcript.lastIndexOf("?", match.index);
  const previousExclamation = transcript.lastIndexOf("!", match.index);
  const sentenceStart = Math.max(start, previousQuestion + 1, previousExclamation + 1);
  const nextStops = [transcript.indexOf(".", match.index + match[0].length), transcript.indexOf("?", match.index + match[0].length), transcript.indexOf("!", match.index + match[0].length)]
    .filter((index) => index >= 0);
  const sentenceEnd = nextStops.length > 0 ? Math.min(...nextStops) + 1 : transcript.length;
  return transcript.slice(sentenceStart, sentenceEnd).trim();
}

function addIssue(
  issues: UnresolvedIssue[],
  issue: Omit<UnresolvedIssue, "id" | "blocking">,
): void {
  if (issues.some((existing) => existing.id === issue.type && existing.measurement_type === issue.measurement_type)) return;
  issues.push({ ...issue, id: issue.measurement_type ? `${issue.type}:${issue.measurement_type}` : issue.type, blocking: true });
}

function parseClockTime(transcript: string): { hour: number; minute: number; precision: TimePrecision; source: string } | null {
  const amPm = /\b(?:at|around|about)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(transcript);
  if (amPm) {
    let hour = Number(amPm[1]) % 12;
    if (amPm[3].toLowerCase().startsWith("p")) hour += 12;
    const nearby = transcript.slice(Math.max(0, amPm.index - 8), amPm.index).toLowerCase();
    return {
      hour,
      minute: Number(amPm[2] ?? 0),
      precision: /\b(?:around|about)\s*$/.test(nearby) ? "period" : "exact",
      source: amPm[0].trim(),
    };
  }

  const twentyFourHour = /\b(?:at|around|about)\s+(\d{1,2}):(\d{2})\b/i.exec(transcript);
  if (twentyFourHour) {
    const hour = Number(twentyFourHour[1]);
    const minute = Number(twentyFourHour[2]);
    if (hour <= 23 && minute <= 59) {
      return {
        hour,
        minute,
        precision: /\b(?:around|about)\s+/i.test(twentyFourHour[0]) ? "period" : "exact",
        source: twentyFourHour[0].trim(),
      };
    }
  }
  return null;
}

function localParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const value = (name: string) => Number(parts.find((part) => part.type === name)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = targetAsUtc;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const part = (name: string) => Number(formatted.find((entry) => entry.type === name)?.value);
    const renderedAsUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
    instant += targetAsUtc - renderedAsUtc;
  }
  return new Date(instant);
}

function extractTime(transcript: string, timeZone: string, now: Date) {
  const today = localParts(now, timeZone);
  const yesterday = /\byesterday\b/i.test(transcript);
  let date = today;
  if (yesterday) {
    const prior = new Date(Date.UTC(today.year, today.month - 1, today.day - 1));
    date = { year: prior.getUTCFullYear(), month: prior.getUTCMonth() + 1, day: prior.getUTCDate() };
  }

  const clock = parseClockTime(transcript);
  if (clock) {
    const source = yesterday ? `yesterday ${clock.source}` : clock.source;
    return {
      observation_time: zonedDateTimeToUtc(date.year, date.month, date.day, clock.hour, clock.minute, timeZone).toISOString(),
      observation_time_precision: clock.precision,
      observation_time_source: source,
    };
  }

  const period = /\b(morning|afternoon|evening|tonight)\b/i.exec(transcript);
  if (period) {
    const normalized = period[1].toLowerCase();
    const hour = normalized === "morning" ? 9 : normalized === "afternoon" ? 15 : 19;
    const precision: TimePrecision = normalized === "morning" ? "morning" : normalized === "afternoon" ? "afternoon" : "evening";
    const prefix = /\b(?:this|today|in the)\s*$/i.exec(transcript.slice(0, period.index))?.[0].trim();
    const source = `${yesterday ? "yesterday " : prefix ? `${prefix} ` : ""}${period[0].toLowerCase()}`;
    return {
      observation_time: zonedDateTimeToUtc(date.year, date.month, date.day, hour, 0, timeZone).toISOString(),
      observation_time_precision: precision,
      observation_time_source: source,
    };
  }

  if (/\b(?:around|about)\s+noon\b|\bnoon\b/i.test(transcript)) {
    const source = `${yesterday ? "yesterday " : ""}around noon`;
    return {
      observation_time: zonedDateTimeToUtc(date.year, date.month, date.day, 12, 0, timeZone).toISOString(),
      observation_time_precision: "period" as const,
      observation_time_source: source,
    };
  }

  if (yesterday) {
    return {
      observation_time: zonedDateTimeToUtc(date.year, date.month, date.day, 12, 0, timeZone).toISOString(),
      observation_time_precision: "day" as const,
      observation_time_source: "yesterday",
    };
  }

  const todayMention = /\btoday\b/i.exec(transcript);
  if (todayMention) {
    return {
      observation_time: zonedDateTimeToUtc(date.year, date.month, date.day, 12, 0, timeZone).toISOString(),
      observation_time_precision: "day" as const,
      observation_time_source: todayMention[0],
    };
  }

  return {
    observation_time: null,
    observation_time_precision: "unknown" as const,
    observation_time_source: null,
  };
}

export function extractTranscript(
  transcript: string,
  options: { timeZone: string; now?: Date },
): ExtractionResult {
  const normalized = transcript.replace(/\s+/g, " ").trim();
  const searchable = normalized.toLowerCase();
  const measurements: ExtractedMeasurement[] = [];
  const observations: ExtractedObservation[] = [];
  const unresolved_issues: UnresolvedIssue[] = [];

  const bloodPressure = /\b(?:blood pressure|bp)\b(?:\s+(?:reading\s+)?(?:was|is|read|measured|at|of))?\s*(\d{2,3})\s*(?:over|\/)\s*(\d{2,3})\b/i.exec(normalized);
  if (bloodPressure) {
    const systolic = Number(bloodPressure[1]);
    const diastolic = Number(bloodPressure[2]);
    measurements.push({
      type: "blood_pressure",
      value: { systolic, diastolic },
      unit: "mmHg",
      confidence: systolic >= 60 && systolic <= 260 && diastolic >= 30 && diastolic <= 160 ? 0.96 : 0.72,
      source_text: textForMatch(normalized, bloodPressure),
    });
  } else if (/\b(?:blood pressure|bp)\b/i.test(searchable)) {
    addIssue(unresolved_issues, {
      type: "ambiguous_value",
      measurement_type: "blood_pressure",
      message: "A blood pressure was mentioned, but its two values could not be read clearly.",
      question: "What were the systolic and diastolic blood pressure numbers?",
      source_text: textForMatch(normalized, /\b(?:blood pressure|bp)\b/i.exec(normalized)!),
    });
  }

  const glucose = /\b(?:(?:blood\s+)?(?:glucose|sugar)(?:\s+(?:level|reading))?)\b[^\d]{0,30}(\d+(?:\.\d+)?)\s*(mg\s*\/?\s*dl|milligrams?\s+per\s+deciliter|mmol\s*\/?\s*l|millimoles?\s+per\s+liter)?/i.exec(normalized);
  if (glucose) {
    const rawUnit = (glucose[2] ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const unit = !rawUnit ? null : /mg|milligram/.test(rawUnit) ? "mg/dL" : "mmol/L";
    measurements.push({
      type: "blood_glucose",
      value: Number(glucose[1]),
      unit,
      confidence: unit ? 0.92 : 0.76,
      source_text: textForMatch(normalized, glucose),
    });
    if (!unit) addIssue(unresolved_issues, {
      type: "missing_unit",
      measurement_type: "blood_glucose",
      message: "The glucose value has no unit, so its scale is unclear.",
      question: "Was this glucose value in mg/dL or mmol/L?",
      source_text: textForMatch(normalized, glucose),
    });
  } else if (/\b(?:(?:blood\s+)?(?:glucose|sugar)(?:\s+(?:level|reading))?)\b/i.test(searchable)) {
    addIssue(unresolved_issues, {
      type: "ambiguous_value",
      measurement_type: "blood_glucose",
      message: "A glucose reading was mentioned, but no numeric value was found.",
      question: "What was the glucose reading?",
      source_text: textForMatch(normalized, /\b(?:(?:blood\s+)?(?:glucose|sugar)(?:\s+(?:level|reading))?)\b/i.exec(normalized)!),
    });
  }

  const temperature = /\b(?:temperature|temp)\b[^\d]{0,24}(\d{2,3}(?:\.\d+)?)\s*(?:°\s*)?(?:degrees?\s*)?(celsius|fahrenheit|c|f)?\b/i.exec(normalized);
  if (temperature) {
    const rawUnit = (temperature[2] ?? "").toLowerCase();
    const unit = rawUnit ? (rawUnit.startsWith("c") ? "°C" : "°F") : null;
    measurements.push({ type: "temperature", value: Number(temperature[1]), unit, confidence: unit ? 0.9 : 0.72, source_text: textForMatch(normalized, temperature) });
    if (!unit) addIssue(unresolved_issues, {
      type: "missing_unit",
      measurement_type: "temperature",
      message: "The temperature has no unit, so the scale is unclear.",
      question: "Was this temperature in Celsius or Fahrenheit?",
      source_text: textForMatch(normalized, temperature),
    });
  } else if (/\b(?:temperature|temp)\b/i.test(searchable)) {
    addIssue(unresolved_issues, {
      type: "ambiguous_value",
      measurement_type: "temperature",
      message: "A temperature was mentioned, but no numeric value was found.",
      question: "What was the temperature reading?",
      source_text: textForMatch(normalized, /\b(?:temperature|temp)\b/i.exec(normalized)!),
    });
  }

  const heartRate = /\b(?:heart\s+rate|pulse)\b[^\d]{0,24}(\d{2,3})\s*(?:bpm|beats?\s+per\s+minute)?\b/i.exec(normalized);
  if (heartRate) {
    measurements.push({ type: "heart_rate", value: Number(heartRate[1]), unit: "bpm", confidence: 0.9, source_text: textForMatch(normalized, heartRate) });
  } else if (/\b(?:heart\s+rate|pulse)\b/i.test(searchable)) {
    addIssue(unresolved_issues, {
      type: "ambiguous_value",
      measurement_type: "heart_rate",
      message: "A heart rate was mentioned, but no numeric value was found.",
      question: "What was the heart rate?",
      source_text: textForMatch(normalized, /\b(?:heart\s+rate|pulse)\b/i.exec(normalized)!),
    });
  }

  const oxygen = /\b(?:spo\s*2|o2\s+sat(?:uration)?|oxygen\s+(?:saturation|level))\b[^\d]{0,24}(\d{2,3})\s*(%|percent)?/i.exec(normalized);
  if (oxygen) {
    measurements.push({ type: "spo2", value: Number(oxygen[1]), unit: "%", confidence: 0.9, source_text: textForMatch(normalized, oxygen) });
  } else if (/\b(?:spo\s*2|o2\s+sat(?:uration)?|oxygen\s+(?:saturation|level))\b/i.test(searchable)) {
    addIssue(unresolved_issues, {
      type: "ambiguous_value",
      measurement_type: "spo2",
      message: "An oxygen saturation was mentioned, but no numeric value was found.",
      question: "What was the oxygen saturation?",
      source_text: textForMatch(normalized, /\b(?:spo\s*2|o2\s+sat(?:uration)?|oxygen\s+(?:saturation|level))\b/i.exec(normalized)!),
    });
  }

  const sentences = normalized.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  const observationRules: Array<{ type: ObservationType; pattern: RegExp; confidence: number }> = [
    { type: "pain", pattern: /\b(?:pain|aches?|sore|hurts?|hurt|cramps?)\b/i, confidence: 0.82 },
    { type: "symptom", pattern: /\b(?:tired|fatigue|dizz(?:y|iness)|nausea|nauseous|headache|fever|cough|shortness of breath|breathless|swelling|vomit(?:ing)?|diarrh(?:ea|oea)|constipat(?:ed|ion)|weakness|shivering|chills?)\b/i, confidence: 0.82 },
    { type: "food", pattern: /\b(?:ate|eaten|eat|drank|drink|breakfast|lunch|dinner|meal|appetite|water|fluids?)\b/i, confidence: 0.8 },
    { type: "mood", pattern: /\b(?:mood|happy|sad|anxious|anxiety|calm|upset|worried|agitated|tearful)\b/i, confidence: 0.78 },
    { type: "sleep", pattern: /\b(?:sleep|slept|sleeping|insomnia|awake|woke|rested|nap)\b/i, confidence: 0.8 },
  ];

  for (const sentence of sentences) {
    const rule = observationRules.find((candidate) => candidate.pattern.test(sentence));
    if (rule) {
      observations.push({ type: rule.type, description: sentence, confidence: rule.confidence, source_text: sentence });
    } else if (!/\b(?:blood pressure|\bbp\b|glucose|blood sugar|temperature|\btemp\b|heart rate|\bpulse\b|spo\s*2|oxygen saturation|oxygen level)\b/i.test(sentence)) {
      observations.push({ type: "free_text", description: sentence, confidence: 0.55, source_text: sentence });
    }
  }

  const time = extractTime(normalized, options.timeZone, options.now ?? new Date());
  if (!time.observation_time) addIssue(unresolved_issues, {
    type: "observation_time_missing",
    message: "No observation time was stated.",
    question: "When was this update observed? For example, today or yesterday?",
    source_text: normalized,
  });

  return {
    measurements,
    observations,
    ...time,
    unresolved_issues,
  };
}
