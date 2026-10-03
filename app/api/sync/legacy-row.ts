/** Legacy SQL names include offsets whose domain field omits the suffix. */
export function camelLegacyRow<T extends Record<string, unknown>>(
  row: T
): Record<string, T[keyof T]> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key
        .replace(/^(source|target)_(start|end)_offset$/, "$1_$2")
        .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ])
  ) as Record<string, T[keyof T]>;
}
