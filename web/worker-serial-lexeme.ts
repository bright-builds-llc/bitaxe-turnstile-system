/** Preserves raw payload size and duplicate envelope keys before JSON normalization. */
export function parseWorkerSerialJson(text: string): {
  value: unknown;
  payloadBytes: number;
} {
  let value: unknown;
  try {
    value = JSON.parse(text, (key: string, field: unknown) => {
      if (!wellFormed(key) || (typeof field === "string" && !wellFormed(field)))
        throw new Error("unicode");
      return field;
    });
  } catch {
    throw invalid();
  }
  let cursor = whitespace(text, 0);
  if (text[cursor++] !== "{") throw invalid();
  const keys = new Set<string>();
  let payloadBytes = 0;
  while (text[cursor] !== "}") {
    cursor = whitespace(text, cursor);
    if (text[cursor] === "}") break;
    const keyStart = cursor;
    cursor = stringEnd(text, cursor);
    const key = JSON.parse(text.slice(keyStart, cursor)) as string;
    if (keys.has(key)) throw invalid();
    keys.add(key);
    cursor = whitespace(text, cursor);
    if (text[cursor++] !== ":") throw invalid();
    cursor = whitespace(text, cursor);
    const start = cursor;
    cursor = valueEnd(text, cursor);
    let end = cursor;
    while (end > start && /\s/u.test(text[end - 1] ?? "")) end--;
    if (key === "payload")
      payloadBytes = new TextEncoder().encode(text.slice(start, end)).length;
    if (text[cursor] === "}") break;
    if (text[cursor++] !== ",") throw invalid();
  }
  return { value, payloadBytes };
}
function whitespace(text: string, cursor: number): number {
  while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor++;
  return cursor;
}
function stringEnd(text: string, cursor: number): number {
  if (text[cursor++] !== '"') throw invalid();
  while (cursor < text.length) {
    const character = text[cursor++];
    if (character === '"') return cursor;
    if (character === "\\") cursor++;
  }
  throw invalid();
}
function valueEnd(text: string, cursor: number): number {
  let depth = 0;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"') {
      cursor = stringEnd(text, cursor);
      continue;
    }
    if (depth === 0 && (character === "," || character === "}")) return cursor;
    if (character === "{" || character === "[") depth++;
    if (character === "}" || character === "]") depth--;
    cursor++;
  }
  throw invalid();
}
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    }
  }
  return true;
}
function invalid(): Error {
  return new Error("Worker Serial json");
}
