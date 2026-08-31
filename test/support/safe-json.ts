type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function toSafeJsonValue(value: unknown, ancestors: WeakSet<object>): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object") return undefined;

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => toSafeJsonValue(item, ancestors) ?? null);
    ancestors.delete(value);
    return result;
  }

  const result: { [key: string]: JsonValue } = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "stack") continue;
    const safeChild = toSafeJsonValue(child, ancestors);
    if (safeChild !== undefined) result[key] = safeChild;
  }
  ancestors.delete(value);
  return result;
}

/** Serialize test-fixture responses without ever echoing stack-trace fields. */
export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(toSafeJsonValue(value, new WeakSet<object>())) ?? "null";
}
