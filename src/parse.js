// Turns raw LLM text into a Map of path -> content. A Map rather than an object
// because keys are untrusted: "__proto__" stays an ordinary key in a Map.

/** The model's output cannot be used as-is. The chain answers this with a repair prompt. */
export class OutputError extends Error {
  constructor(message, { truncated = false } = {}) {
    super(message);
    this.name = 'OutputError';
    this.truncated = truncated;
  }
}

/** Removes code fences or stray prose around the object. The object itself must still be strict JSON. */
function unwrap(raw) {
  const text = raw.replace(/^﻿/, '').trim();
  if (text.startsWith('{') && text.endsWith('}')) return text;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new OutputError('The response does not contain a JSON object.');
  return text.slice(start, end + 1);
}

export function parseFileMap(raw) {
  let parsed;
  try {
    parsed = JSON.parse(unwrap(raw));
  } catch (err) {
    if (err instanceof OutputError) throw err;
    throw new OutputError(`The response is not valid JSON: ${err.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OutputError('The top-level JSON value must be an object of file paths to file contents.');
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new OutputError('The JSON object has no files in it.');

  const wrongType = entries.filter(([, value]) => typeof value !== 'string').map(([key]) => key);
  if (wrongType.length > 0) {
    throw new OutputError(`These keys must have string values holding raw file content: ${wrongType.join(', ')}`);
  }
  return new Map(entries);
}

/**
 * Spots top-level keys in a partial JSON stream so the UI can name each file as
 * it is written. It only drives progress display: parseFileMap decides validity.
 */
export function createKeyTracker(onKey) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let expectKey = false;
  let isKey = false;
  let buffer = '';

  const closeString = () => {
    inString = false;
    if (!isKey || depth !== 1) return;
    expectKey = false;
    try {
      onKey(JSON.parse(`"${buffer}"`));
    } catch {
      // A malformed key is reported properly by parseFileMap later.
    }
  };

  return {
    push(chunk) {
      for (const ch of chunk) {
        if (inString) {
          if (isKey) buffer += ch;
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') {
            if (isKey) buffer = buffer.slice(0, -1);
            closeString();
          }
          continue;
        }
        if (ch === '{') {
          depth += 1;
          if (depth === 1) expectKey = true;
        } else if (ch === '}') {
          depth = Math.max(0, depth - 1);
        } else if (depth === 1) {
          if (ch === '"') {
            inString = true;
            isKey = expectKey;
            buffer = '';
          } else if (ch === ',') {
            expectKey = true;
          } else if (ch === ':') {
            expectKey = false;
          }
        }
      }
    },
    reset() {
      depth = 0;
      inString = false;
      escaped = false;
      expectKey = false;
      isKey = false;
      buffer = '';
    },
  };
}
