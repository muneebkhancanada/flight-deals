/**
 * Official Kuwait International Airport flight feed.
 *
 * The endpoint returns ONE combined payload containing both arrivals and
 * departures, so it is requested exactly once per refresh and parsed once
 * (never re-fetched per direction, never re-parsed).
 *
 * Record shape (abridged):
 *   { flightDate, lastUpdate, departure|null, arrival|null,
 *     airline: { name, number, iata, code } }
 * The populated `arrival` or `departure` object carries routes, flightId,
 * flightStatus, terminal, gate, scheduled, estimated, actual.
 */

import { AIRLINE_ICAO_TO_IATA, KWI_FLIGHTS_API, PRIORITY_AIRLINES } from "../config.js";
import {
  fetchWithTimeout,
  formatLocalDate,
  formatLocalTime,
  isPlaceholderMidnight,
  kuwaitLocalToUtc,
  minutesBetween,
  sanitizeText,
} from "../util.js";

/**
 * Normalise "KAC" + "374" (or a raw "KAC374") into the passenger-facing
 * IATA form "KU374". Unmapped designators are preserved unchanged.
 */
export function normalizeFlightNumber(airline = {}) {
  const code = (airline.code || "").trim().toUpperCase();
  const number = String(airline.number ?? "").trim();
  const raw = (airline.iata || `${code}${number}`).trim().toUpperCase();
  if (code && number && AIRLINE_ICAO_TO_IATA[code]) {
    return `${AIRLINE_ICAO_TO_IATA[code]}${number}`;
  }
  // Raw identifier may itself start with a known ICAO designator (e.g. "KAC374").
  const match = raw.match(/^([A-Z]{3})(\d.*)$/);
  if (match && AIRLINE_ICAO_TO_IATA[match[1]]) {
    return `${AIRLINE_ICAO_TO_IATA[match[1]]}${match[2]}`;
  }
  return raw || null;
}

/** True when the airline matches one of the highlighted priority carriers. */
export function isPriorityAirline(airline = {}) {
  const name = (airline.name || "").toLowerCase();
  const code = (airline.code || "").toUpperCase();
  return PRIORITY_AIRLINES.some(
    (p) => p.codes.includes(code) || (name && name.includes(p.name.toLowerCase())),
  );
}

/**
 * Read an estimated/actual timestamp, converting the feed's midnight
 * placeholder ("...T00:00:00") to null rather than a real time.
 */
function movementTime(value) {
  if (!value || isPlaceholderMidnight(value)) return null;
  return kuwaitLocalToUtc(value);
}

/** Canonicalise the free-text status the airport publishes. */
export function normalizeStatus(rawStatus) {
  const s = (rawStatus || "").trim();
  if (!s) return { status: "Unknown", cancelled: false, diverted: false };
  const lower = s.toLowerCase();
  const cancelled = /cancel/.test(lower);
  const diverted = /divert/.test(lower);
  let status = s;
  if (cancelled) status = "Cancelled";
  else if (diverted) status = "Diverted";
  else if (/delay/.test(lower)) status = "Delayed";
  else if (/departed|airborne|took off/.test(lower)) status = "Departed";
  else if (/arrived|landed/.test(lower)) status = "Arrived";
  else if (/on ?time/.test(lower)) status = "On Time";
  else if (/boarding|gate|final call|check.?in/.test(lower)) status = s;
  else if (/scheduled|expected/.test(lower)) status = "Scheduled";
  return { status, cancelled, diverted };
}

/**
 * Parse one raw KWI record into the normalized flight model.
 * Returns null for records that carry neither arrival nor departure data.
 */
export function parseKwiFlightRecord(record, timezone = "Asia/Kuwait") {
  if (!record || typeof record !== "object") return null;
  const movement = record.arrival || record.departure;
  if (!movement || typeof movement !== "object") return null;
  const direction = record.arrival ? "arrival" : "departure";

  const airline = record.airline || {};
  const flightNumber = normalizeFlightNumber(airline);
  if (!flightNumber) return null;

  // `routes` lists the non-KWI end(s) of the trip; multi-stop services carry
  // several entries in travel order. The first entry is the primary far-end
  // airport for matching; the label shows the whole chain.
  const routes = Array.isArray(movement.routes) ? movement.routes.filter(Boolean) : [];
  const primaryRoute = routes[0] || {};
  const farAirport = (primaryRoute.airportCode || "").toUpperCase() || null;
  const cityChain = routes
    .map((r) => sanitizeText(r.city || r.airportName, 60))
    .filter(Boolean);
  const routeLabel =
    direction === "arrival"
      ? [...cityChain, "Kuwait"].join(" → ")
      : ["Kuwait", ...cityChain].join(" → ");

  const scheduledUtc = kuwaitLocalToUtc(movement.scheduled || record.flightDate);
  const estimatedUtc = movementTime(movement.estimated);
  const actualUtc = movementTime(movement.actual);
  const { status, cancelled, diverted } = normalizeStatus(movement.flightStatus?.status);

  // Delay = best-known movement time vs schedule. Actual wins over estimate.
  const delayMinutes = minutesBetween(scheduledUtc, actualUtc ?? estimatedUtc);

  return {
    id: movement.flightId || `${direction}_${flightNumber}_${scheduledUtc || "tbc"}`,
    direction,
    flightNumber,
    rawIdentifier: sanitizeText(airline.iata, 20),
    airline: sanitizeText(airline.name, 80) || "Unknown airline",
    origin: direction === "arrival" ? farAirport : "KWI",
    destination: direction === "arrival" ? "KWI" : farAirport,
    routeLabel: sanitizeText(routeLabel, 200),
    scheduledUtc,
    estimatedUtc,
    actualUtc,
    scheduledLocal: formatLocalTime(scheduledUtc, timezone),
    scheduledLocalDate: formatLocalDate(scheduledUtc, timezone),
    estimatedLocal: formatLocalTime(estimatedUtc, timezone),
    actualLocal: formatLocalTime(actualUtc, timezone),
    status,
    delayMinutes,
    cancelled,
    diverted,
    terminal: sanitizeText(movement.terminal, 12),
    gate: sanitizeText(movement.gate, 12),
    priority: isPriorityAirline(airline),
    source: KWI_FLIGHTS_API.sourceName,
    sourceUrl: KWI_FLIGHTS_API.publicUrl,
    lastUpdated: kuwaitLocalToUtc(record.lastUpdate) || null,
  };
}

/**
 * Parse the whole payload. Distinguishes "parsed zero flights" from
 * "payload was not parseable" — the caller must never present a broken
 * payload as an empty airport.
 */
export function parseKwiPayload(payload, timezone = "Asia/Kuwait") {
  if (!payload || !Array.isArray(payload.result)) {
    return { ok: false, flights: [], error: "Unexpected payload shape: missing result array" };
  }
  const flights = [];
  let skipped = 0;
  for (const record of payload.result) {
    try {
      const flight = parseKwiFlightRecord(record, timezone);
      if (flight) flights.push(flight);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  // If everything was skipped on a non-empty payload, the structure has
  // drifted — report failure instead of pretending the airport is empty.
  if (payload.result.length > 0 && flights.length === 0) {
    return { ok: false, flights: [], error: `Payload had ${payload.result.length} records but none parsed` };
  }
  return { ok: true, flights, skipped };
}

/**
 * Fetch and parse the official feed. Requires the KWI_API_AUTH secret; the
 * credential is sent only server-side and never logged or stored.
 */
export async function collectKwiFlights(env, config) {
  const checkedAt = new Date().toISOString();
  const health = {
    id: "kwi-official-api",
    name: KWI_FLIGHTS_API.sourceName,
    type: "Official airport JSON API",
    url: KWI_FLIGHTS_API.publicUrl,
    checkedAt,
    status: "unavailable",
    records: null,
    message: null,
  };

  if (!env.KWI_API_AUTH) {
    health.status = "not-configured";
    health.message = "KWI_API_AUTH secret is not set. Run: npx wrangler secret put KWI_API_AUTH";
    return { ok: false, flights: [], health };
  }

  try {
    const response = await fetchWithTimeout(KWI_FLIGHTS_API.url, {
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "accept-language": "en-US",
        authorization: env.KWI_API_AUTH,
        "x-requested-with": "XMLHttpRequest",
        referer: KWI_FLIGHTS_API.referer,
      },
    });
    if (!response.ok) {
      health.message = `Airport API responded HTTP ${response.status}`;
      return { ok: false, flights: [], health };
    }
    const payload = await response.json();
    const parsed = parseKwiPayload(payload, config.timezone);
    if (!parsed.ok) {
      health.status = "degraded";
      health.message = parsed.error;
      return { ok: false, flights: [], health };
    }
    health.status = "ok";
    health.records = parsed.flights.length;
    health.message =
      parsed.flights.length === 0
        ? "Feed reachable; airport published no flight records in the current payload"
        : null;
    return { ok: true, flights: parsed.flights, health };
  } catch (error) {
    health.message =
      error?.name === "AbortError"
        ? "Airport API timed out"
        : `Airport API request failed: ${sanitizeText(error?.message, 160) || "unknown error"}`;
    return { ok: false, flights: [], health };
  }
}
