/**
 * Operational display derivation — separate from parsing so the rules can be
 * unit-tested and reused. Computed server-side and attached to each flight
 * as `flight.display`, so the frontend only renders.
 *
 * Rules (from the operations spec):
 *  - A completed movement takes precedence over the delay flag: a late flight
 *    that has departed shows "Departed 18:05" with "40 min late" underneath —
 *    never a bare "Delayed".
 *  - Tone: green = on-time/normal; amber = currently delayed, or completed
 *    <2h late; red = cancelled/diverted or ≥2h late; neutral = unknown.
 *  - A delayed flight must never turn green just because it eventually moved.
 */

import { formatDuration } from "./util.js";

/** Delays under this many minutes count as "on time" for display purposes. */
const ON_TIME_TOLERANCE_MIN = 10;
const MAJOR_DELAY_MIN = 120;

export function deriveDisplay(flight) {
  const dirVerb = flight.direction === "arrival" ? "Arrived" : "Departed";
  const dirNoun = flight.direction === "arrival" ? "arrival" : "departure";
  const delay = flight.delayMinutes;
  const late = delay != null && delay >= ON_TIME_TOLERANCE_MIN;

  if (flight.cancelled) {
    return {
      tone: "red",
      primary: "Cancelled",
      secondary: flight.scheduledLocal ? `Was scheduled ${flight.scheduledLocal}` : null,
      timeLabel: `Scheduled ${dirNoun}`,
      displayTimeUtc: flight.scheduledUtc,
      displayTimeLocal: flight.scheduledLocal,
    };
  }

  if (flight.diverted) {
    return {
      tone: "red",
      primary: "Diverted",
      secondary: flight.routeLabel || null,
      timeLabel: `Scheduled ${dirNoun}`,
      displayTimeUtc: flight.scheduledUtc,
      displayTimeLocal: flight.scheduledLocal,
    };
  }

  // Completed movement: report the fact first, the lateness second.
  if (flight.actualUtc) {
    const primary = `${dirVerb} ${flight.actualLocal ?? ""}`.trim();
    if (late) {
      return {
        tone: delay >= MAJOR_DELAY_MIN ? "red" : "amber",
        primary,
        secondary: `${formatDuration(delay)} late`,
        timeLabel: `Actual ${dirNoun}`,
        displayTimeUtc: flight.actualUtc,
        displayTimeLocal: flight.actualLocal,
      };
    }
    return {
      tone: "green",
      primary,
      secondary: "On time",
      timeLabel: `Actual ${dirNoun}`,
      displayTimeUtc: flight.actualUtc,
      displayTimeLocal: flight.actualLocal,
    };
  }

  // Status says departed/arrived but no actual time was published.
  if (flight.status === "Departed" || flight.status === "Arrived") {
    return {
      tone: late ? (delay >= MAJOR_DELAY_MIN ? "red" : "amber") : "green",
      primary: flight.status,
      secondary: late ? `${formatDuration(delay)} late` : "Time not published",
      timeLabel: `Estimated ${dirNoun}`,
      displayTimeUtc: flight.estimatedUtc || flight.scheduledUtc,
      displayTimeLocal: flight.estimatedLocal || flight.scheduledLocal,
    };
  }

  // Still pending and currently delayed.
  if (flight.status === "Delayed" || late) {
    const dur = late ? formatDuration(delay) : null;
    return {
      tone: delay != null && delay >= MAJOR_DELAY_MIN ? "red" : "amber",
      primary: dur ? `Delayed ${dur}` : "Delayed",
      secondary: flight.estimatedLocal
        ? `Estimated ${dirNoun} ${flight.estimatedLocal}`
        : "New time not yet published",
      timeLabel: flight.estimatedUtc ? `Estimated ${dirNoun}` : `Scheduled ${dirNoun}`,
      displayTimeUtc: flight.estimatedUtc || flight.scheduledUtc,
      displayTimeLocal: flight.estimatedLocal || flight.scheduledLocal,
    };
  }

  if (flight.status === "Unknown" && !flight.scheduledUtc) {
    return {
      tone: "neutral",
      primary: "Status unavailable",
      secondary: null,
      timeLabel: `Scheduled ${dirNoun}`,
      displayTimeUtc: null,
      displayTimeLocal: null,
    };
  }

  // Normal pending operation (scheduled / on time / boarding etc.).
  const pendingStatus =
    flight.status === "Unknown" || flight.status === "Scheduled"
      ? "Scheduled"
      : flight.status;
  return {
    tone: flight.status === "Unknown" ? "neutral" : "green",
    primary: pendingStatus,
    secondary: flight.estimatedLocal ? `Estimated ${dirNoun} ${flight.estimatedLocal}` : null,
    timeLabel: flight.estimatedUtc ? `Estimated ${dirNoun}` : `Scheduled ${dirNoun}`,
    displayTimeUtc: flight.estimatedUtc || flight.scheduledUtc,
    displayTimeLocal: flight.estimatedLocal || flight.scheduledLocal,
  };
}

/** Attach display info to every flight (used when building the snapshot). */
export function withDisplay(flights) {
  return flights.map((flight) => ({ ...flight, display: deriveDisplay(flight) }));
}
