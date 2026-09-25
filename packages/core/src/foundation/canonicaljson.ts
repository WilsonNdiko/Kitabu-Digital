/**
 * Canonical JSON — deterministic serialization for tamper-evidence digests
 * (docs/RECEIPTS.md §5): object keys sorted recursively, no insignificant
 * whitespace, UTF-8. The same snapshot always produces the same digest on every
 * device, forever.
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortValue(source[key]);
  }
  return sorted;
}
