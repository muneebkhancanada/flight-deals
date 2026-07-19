/**
 * Flight-list post-processing: de-duplication, time-window filtering and
 * summary statistics. Pure functions — no I/O.
 */

/**
 * Deterministic de-duplication. Two records describe the same flight when
 * direction + flight number + scheduled instant match. Sources earlier in
 * `sourcePriority` win (official KWI data beats any fallback source).
 */
export function dedupeFlights(flights, sourcePriority = ["Kuwait International Airport"]) {
  const rank = (flight) => {
    const i = sourcePriority.indexOf(flight.source);
    return i === -1 ? sourcePriority.length : i;
  };
  const byKey = new Map();
  for (const flight of flights) {
    const key = `${flight.direction}|${flight.flightNumber}|${flight.scheduledUtc || flight.id}`;
    const existing = byKey.get(key);
    if (!existing || rank(flight) < rank(existing)) byKey.set(key, flight);
  }
  return [...byKey.values()].sort((a, b) =>
    String(a.scheduledUtc || "").localeCompare(String(b.scheduledUtc || "")),
  );
}

/** A flight is "completed" once a real (non-placeholder) actual time exists. */
export function isCompleted(flight) {
  return Boolean(flight.actualUtc) || flight.status === "Departed" || flight.status === "Arrived";
}

/**
 * Keep: completed movements from the last `historyHours`, and published
 * flights up to `futureHours` ahead. A still-active flight (not completed,
 * not cancelled) whose *estimate* is inside the window is kept even when its
 * original schedule has slipped just outside it — passengers still need it.
 */
export function filterFlightWindow(flights, nowIso, { historyHours = 12, futureHours = 96 } = {}) {
  const now = Date.parse(nowIso);
  const earliest = now - historyHours * 3_600_000;
  const latest = now + futureHours * 3_600_000;
  const inWindow = (iso) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= earliest && t <= latest;
  };
  return flights.filter((flight) => {
    if (isCompleted(flight)) {
      // Completed movements are judged by when they actually happened.
      return inWindow(flight.actualUtc || flight.estimatedUtc || flight.scheduledUtc);
    }
    return inWindow(flight.scheduledUtc) || inWindow(flight.estimatedUtc);
  });
}

/** Headline counts for the summary cards and alerting. */
export function summarizeFlights(flights) {
  const summary = {
    arrivals: 0,
    departures: 0,
    delayed: 0,
    delayedTwoHours: 0,
    cancelled: 0,
    diverted: 0,
    priorityAffected: 0,
  };
  for (const flight of flights) {
    if (flight.direction === "arrival") summary.arrivals += 1;
    else summary.departures += 1;
    const delayed = (flight.delayMinutes ?? 0) >= 10 || flight.status === "Delayed";
    if (delayed && !flight.cancelled && !flight.diverted) summary.delayed += 1;
    if ((flight.delayMinutes ?? 0) >= 120 && !flight.cancelled && !flight.diverted) {
      summary.delayedTwoHours += 1;
    }
    if (flight.cancelled) summary.cancelled += 1;
    if (flight.diverted) summary.diverted += 1;
    if (flight.priority && (delayed || flight.cancelled || flight.diverted)) {
      summary.priorityAffected += 1;
    }
  }
  return summary;
}
