/**
 * Shared helpers: timeouts, time conversion, text sanitisation.
 * All functions are pure (except fetchWithTimeout) so they are unit-testable
 * under plain Node.
 */

import { KUWAIT_UTC_OFFSET, FETCH_TIMEOUT_MS } from "./config.js";

/**
 * fetch() with an AbortController timeout so one slow upstream can never
 * stall a refresh cycle or exhaust Worker CPU time.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The KWI API returns naive local timestamps like "2026-07-19T06:30:00".
 * Kuwait is fixed UTC+3 (no DST), so appending the offset converts exactly.
 * Returns an ISO UTC string, or null for empty/unparseable input.
 */
export function kuwaitLocalToUtc(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(trimmed)) return null;
  const ms = Date.parse(trimmed.slice(0, 19) + KUWAIT_UTC_OFFSET);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * The KWI feed uses a midnight time ("...T00:00:00") as a placeholder for
 * "no estimated/actual time published yet". A genuine midnight movement is
 * rare enough that treating exact midnight as missing is the safer read —
 * misreporting a delayed flight as "actually departed 00:00" is worse.
 * Only apply this to estimated/actual fields, never to scheduled times.
 */
export function isPlaceholderMidnight(value) {
  if (!value || typeof value !== "string") return false;
  return /T00:00:00/.test(value.trim());
}

/** Whole minutes from ISO `fromIso` to ISO `toIso` (positive = later). */
export function minutesBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 60_000);
}

/** "HH:MM" in the given IANA timezone for an ISO UTC instant. */
export function formatLocalTime(iso, timezone = "Asia/Kuwait") {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

/** "Sat 19 Jul" in the given timezone, for disambiguating a 108-hour window. */
export function formatLocalDate(iso, timezone = "Asia/Kuwait") {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(new Date(ms));
}

/** "40 min" / "2h 35m" human delay duration. */
export function formatDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  const abs = Math.abs(Math.round(minutes));
  if (abs < 60) return `${abs} min`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Sanitise externally supplied text before it is stored in a snapshot:
 * strip tags/control characters, collapse whitespace, cap length. The
 * frontend additionally HTML-escapes everything it renders — this is
 * defence in depth, not the only barrier.
 */
export function sanitizeText(value, maxLength = 600) {
  if (value == null) return null;
  const text = String(value)
    .replace(/<[^>]*>/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Only allow http(s) URLs into snapshots so links can never be javascript:. */
export function safeHttpUrl(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Age of an ISO timestamp in whole seconds, or null. */
export function ageSeconds(iso, nowMs = Date.now()) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((nowMs - ms) / 1000));
}
