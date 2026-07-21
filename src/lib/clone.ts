/** Cheap deep clone for plain JSON-serializable objects (no functions/Dates). */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
