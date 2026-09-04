/** Keep parser-derived mirror columns within their MySQL varchar(255) limit. */
export function mirrorSafeBookField(value: string): string {
  const text = value.replaceAll("\0", "").trim();
  let bounded = text.slice(0, 255);
  const finalCodeUnit = bounded.charCodeAt(bounded.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    bounded = bounded.slice(0, -1);
  }
  return bounded;
}
