export const DEFAULT_LINES = 200;
export const MAX_WAIT_SECONDS = 3600;
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;

export function seconds(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0 || result > MAX_WAIT_SECONDS) {
    throw new Error(`${label} must be from 0 to ${MAX_WAIT_SECONDS} seconds`);
  }
  return Math.round(result * 1000);
}

export function lineCount(value: number | undefined): number {
  const result = value ?? DEFAULT_LINES;
  if (!Number.isInteger(result) || result < 1 || result > 1000) {
    throw new Error("lines must be an integer from 1 to 1000");
  }
  return result;
}

export function regex(value: string | undefined): void {
  if (value !== undefined) {
    if (!value) throw new Error("Log pattern must not be empty");
    new RegExp(value, "u");
  }
}

export function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

export function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
