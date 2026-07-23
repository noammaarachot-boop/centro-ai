// Tool results must be genuinely JSON-serializable — confirmed live via
// a real AI_InvalidPromptError: the provider SDK re-validates the full
// message array (including every prior tool result) before each step
// after the first in a multi-step agent loop, and a raw Date instance
// (exactly what every src/lib/data/* function returns for a timestamp
// column, matching how the rest of this codebase always handles dates)
// fails that validation, even though the very same value was accepted
// as this tool's own return value on step one. A plain JSON round-trip
// converts every Date to its ISO string via its own toJSON(), which is
// both sufficient and the same representation the model would see
// either way (a stringified date), so nothing is lost.
export function toJsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
