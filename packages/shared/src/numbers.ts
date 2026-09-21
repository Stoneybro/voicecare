// Spoken-number resolution (spec/04 "Handle spoken numbers accurately").
//
// The extractor and any voice-agent fallback both call this so "one thirty-eight over eighty-eight"
// and "seventy—sorry, seventy-two" become numbers before a field pattern is applied.

const DIGIT_WORDS: Record<string, number> = {
  zero: 0,
  oh: 0,
  o: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

const TEEN_WORDS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS_WORDS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const SCALE_WORDS: Record<string, number> = { hundred: 100, thousand: 1000 };
const CONNECTOR_WORDS = new Set(["and", "point"]);

export function isNumberWord(token: string): boolean {
  const normalized = token.toLowerCase();
  return (
    normalized in DIGIT_WORDS ||
    normalized in TEEN_WORDS ||
    normalized in TENS_WORDS ||
    normalized in SCALE_WORDS ||
    CONNECTOR_WORDS.has(normalized)
  );
}

// "thirty-seven" is one token on the page but two numbers in speech. The tokenizer in
// resolveSpokenNumbers already separates dashes, so this helper only handles a stray compound word.
export function splitCompoundNumberToken(token: string): string[] {
  const parts = token.split(/[-–—]/);
  if (parts.length > 1 && parts.every((part) => isNumberWord(part))) return parts;
  return [token];
}

function digitValue(token: string): number | undefined {
  return DIGIT_WORDS[token.toLowerCase()];
}

function readScaleRun(tokens: string[]): string | null {
  let total = 0;
  let current = 0;
  let sawScale = false;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "and") continue;
    if (lower === "point") return null;
    const scale = SCALE_WORDS[lower];
    if (scale !== undefined) {
      sawScale = true;
      current = current === 0 ? scale : current * scale;
      total += current;
      current = 0;
      continue;
    }
    const tens = TENS_WORDS[lower];
    if (tens !== undefined) {
      current += tens;
      continue;
    }
    const teen = TEEN_WORDS[lower];
    if (teen !== undefined) {
      current += teen;
      continue;
    }
    const digit = digitValue(lower);
    if (digit !== undefined) {
      current += digit;
      continue;
    }
    return null;
  }
  if (!sawScale) return null;
  return String(total + current);
}

function readGroupedRun(tokens: string[]): string | null {
  let out = "";
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index].toLowerCase();
    if (token === "and") return null;
    const tens = TENS_WORDS[token];
    const next = index + 1 < tokens.length ? digitValue(tokens[index + 1]) : undefined;
    if (tens !== undefined && next !== undefined) {
      out += String(tens + next);
      index += 2;
      continue;
    }
    if (tens !== undefined) {
      out += String(tens);
      index += 1;
      continue;
    }
    const teen = TEEN_WORDS[token];
    if (teen !== undefined) {
      out += String(teen);
      index += 1;
      continue;
    }
    const digit = digitValue(token);
    if (digit !== undefined) {
      out += String(digit);
      index += 1;
      continue;
    }
    return null;
  }
  return out.replace(/^0+(?=\d)/, "");
}

function readDecimalRun(tokens: string[]): string | null {
  const pointIndex = tokens.findIndex((token) => token.toLowerCase() === "point");
  if (pointIndex === -1) return null;
  const integerTokens = tokens.slice(0, pointIndex);
  const fractionTokens = tokens.slice(pointIndex + 1);
  if (fractionTokens.length === 0) return null;
  const integer = integerTokens.length === 0 ? "0" : (readScaleRun(integerTokens) ?? readGroupedRun(integerTokens));
  if (integer === null) return null;
  const fraction: string[] = [];
  for (const token of fractionTokens) {
    const lower = token.toLowerCase();
    const digit = digitValue(lower);
    if (digit !== undefined) {
      fraction.push(String(digit));
      continue;
    }
    const teen = TEEN_WORDS[lower];
    if (teen !== undefined) {
      fraction.push(String(teen));
      continue;
    }
    const tens = TENS_WORDS[lower];
    if (tens !== undefined) {
      fraction.push(String(tens));
      continue;
    }
    return null;
  }
  return `${integer}.${fraction.join("")}`;
}

// A run is only converted when it reads as a number on its own. Bare "one"/"a" stay words because
// in ordinary speech they are far more often articles or pronouns than measurements.
function convertRun(tokens: string[]): string | null {
  const trimmed = tokens.filter((token) => token.trim().length > 0);
  if (trimmed.length === 0) return null;
  const decimal = readDecimalRun(trimmed);
  if (decimal !== null) return decimal;
  const scaled = readScaleRun(trimmed);
  if (scaled !== null) return scaled;
  const grouped = readGroupedRun(trimmed);
  if (grouped === null || grouped.length === 0) return null;
  if (grouped.length === 1) {
    const only = trimmed[0].toLowerCase();
    if (only === "one" || only === "a" || only === "oh" || only === "o") return null;
  }
  return grouped;
}

export function resolveSpokenNumbers(text: string): string {
  // Splitting punctuation into its own token keeps "seventy—sorry, seventy-two" from merging into a
  // single number while still allowing "thirty-seven" and "one hundred and thirty-eight".
  const pieces = text.match(/\s+|\p{L}+|\p{N}+|[^\s\p{L}\p{N}]/gu) ?? [];
  const out: string[] = [];
  let index = 0;
  const isDash = (value: string): boolean => value === "-" || value === "–" || value === "—";

  while (index < pieces.length) {
    const piece = pieces[index];
    if (!isNumberWord(piece)) {
      out.push(piece);
      index += 1;
      continue;
    }
    const run: string[] = [piece];
    let cursor = index + 1;
    while (cursor < pieces.length) {
      const current = pieces[cursor];
      if (/^\s+$/.test(current)) {
        // A single space keeps a run going; a line break ends it.
        const next = pieces[cursor + 1];
        const following = pieces[cursor + 2];
        const continues = next !== undefined && (isNumberWord(next) || (isDash(next) && following !== undefined && isNumberWord(following)));
        if (current === " " && continues) {
          cursor += 1;
          continue;
        }
        break;
      }
      if (isDash(current)) {
        const next = pieces[cursor + 1];
        if (run.length > 0 && next !== undefined && isNumberWord(next)) {
          cursor += 1;
          continue;
        }
        break;
      }
      if (!isNumberWord(current)) break;
      run.push(current);
      cursor += 1;
    }
    const converted = convertRun(run);
    if (converted === null) {
      out.push(pieces.slice(index, cursor).join(""));
    } else {
      out.push(converted);
    }
    index = cursor;
  }
  return out.join("");
}


