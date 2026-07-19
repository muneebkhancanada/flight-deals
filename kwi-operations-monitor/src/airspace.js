/**
 * Kuwait airspace status determination.
 *
 * Evidence hierarchy (strongest first):
 *   1. DGCA/government notices (via the advisory scan of dgca.gov.kw)
 *   2. NOTAMs — an active FIR/airspace-closure NOTAM is decisive
 *   3. Observed official KWI flight activity (supporting evidence only)
 *   4. Airline advisories (supporting evidence only)
 *
 * Crucially: a broken flight feed is NOT evidence of closed airspace. When
 * the feed failed we either fall back to NOTAM evidence or report "unknown".
 */

const CLOSURE_CATEGORIES = new Set(["Airspace closure / FIR restriction", "Airport closure"]);
const RESTRICTION_CATEGORIES = new Set([
  "Conflict / military hazard",
  "GPS / GNSS interference",
  "ATC / radar / communications outage",
]);

/**
 * @param {object} input
 * @param {Array}  input.notams          all classified NOTAMs (not just displayed)
 * @param {object} input.flightEvidence  { sourceOk, totalFlights, recentMovements }
 * @param {Array}  input.advisories      advisory hits (government entries weigh more)
 * @param {string} input.nowIso
 */
export function determineAirspace({ notams = [], flightEvidence = {}, advisories = [], nowIso }) {
  const updatedAt = nowIso || new Date().toISOString();
  const closure = notams.find((n) => CLOSURE_CATEGORIES.has(n.category));
  if (closure) {
    return {
      status: "closed",
      confidence: "high",
      reason: `An active official notice (${closure.reference}) reports: ${closure.category.toLowerCase()}. ${closure.meaning || ""}`.trim(),
      source: "Kuwait DGCA NOTAM",
      sourceUrl: closure.url,
      updatedAt,
    };
  }

  const restriction = notams.find((n) => RESTRICTION_CATEGORIES.has(n.category));
  const governmentAdvisory = advisories.find((a) => a.government);

  if (restriction) {
    return {
      status: "restricted",
      confidence: "medium",
      reason: `Airspace is operating with restrictions: ${restriction.category.toLowerCase()} (${restriction.reference}). Flights continue but disruption is possible.`,
      source: "Kuwait DGCA NOTAM",
      sourceUrl: restriction.url,
      updatedAt,
    };
  }

  const { sourceOk = false, recentMovements = 0, totalFlights = 0 } = flightEvidence;
  if (sourceOk && recentMovements > 0) {
    return {
      status: "open",
      // "medium" (not high) because this is inferred from observed traffic,
      // not from an explicit official "airspace open" statement. The frontend
      // styles this as muted green.
      confidence: "medium",
      reason: `Flights are actively operating: ${recentMovements} movement(s) completed at KWI in the recent window and no closure notice is in effect.`,
      source: "Kuwait International Airport flight data + DGCA NOTAMs",
      sourceUrl: "https://www.kuwaitairport.gov.kw/en/flights-info/flight-status/arrivals/",
      updatedAt,
    };
  }

  if (sourceOk && totalFlights > 0) {
    return {
      status: "open",
      confidence: "low",
      reason:
        "Future flights remain published by the airport and no closure notice is in effect, but no completed movements were observed in the recent window.",
      source: "Kuwait International Airport flight data",
      sourceUrl: "https://www.kuwaitairport.gov.kw/en/flights-info/flight-status/arrivals/",
      updatedAt,
    };
  }

  if (governmentAdvisory) {
    return {
      status: "unknown",
      confidence: "low",
      reason:
        "A Kuwait government notice was detected but live flight data is unavailable; airspace status cannot be confirmed either way.",
      source: governmentAdvisory.airline,
      sourceUrl: governmentAdvisory.url,
      updatedAt,
    };
  }

  // No usable evidence — say so honestly. Never infer "closed" from silence.
  return {
    status: "unknown",
    confidence: "low",
    reason:
      "Live data sources are currently unavailable, so airspace status cannot be determined. This does NOT mean the airspace is closed.",
    source: "No live source available",
    sourceUrl: null,
    updatedAt,
  };
}

/** Count completed movements in the last few hours as "activity" evidence. */
export function buildFlightEvidence(flights, sourceOk, nowIso, lookbackHours = 6) {
  const now = Date.parse(nowIso || new Date().toISOString());
  const cutoff = now - lookbackHours * 3_600_000;
  const recentMovements = flights.filter((f) => {
    if (!f.actualUtc) return false;
    const t = Date.parse(f.actualUtc);
    return Number.isFinite(t) && t >= cutoff && t <= now;
  }).length;
  return { sourceOk, totalFlights: flights.length, recentMovements };
}
