// Human-readable byte formatting. Single source of truth reused by every
// screen and component. Base-1000 units (kB/MB/GB) to match macOS Finder.

const UNITS = ["B", "kB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const exp = Math.min(
    UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1000))
  );
  const value = bytes / Math.pow(1000, exp);
  const digits = exp === 0 ? 0 : fractionDigits;
  return `${value.toFixed(digits)} ${UNITS[exp]}`;
}
