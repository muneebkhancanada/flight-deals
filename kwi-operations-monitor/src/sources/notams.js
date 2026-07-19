/**
 * Kuwait DGCA NOTAM ingestion and classification.
 *
 * Retrieval uses the FAA external NOTAM Search service, which republishes
 * international NOTAMs (including OKKK — the Kuwait FIR — and OKBK, Kuwait
 * International). It needs no credential, but it is best-effort: when it is
 * unreachable the refresh continues and the source is marked degraded.
 *
 * Classification is deliberately conservative and keyword-based:
 *  - ALL retrieved NOTAMs feed the airspace-status engine.
 *  - Only "major"/"critical" NOTAMs are displayed; routine notices (cranes,
 *    rigs, stands, minor taxiway work, chart amendments, isolated lighting)
 *    are hidden from the public dashboard.
 */

import { NOTAM_SOURCE } from "../config.js";
import { fetchWithTimeout, sanitizeText, safeHttpUrl } from "../util.js";

/**
 * Ordered rules: the first match decides the category. Each rule carries the
 * plain-English framing the dashboard shows to travellers.
 */
const MAJOR_RULES = [
  {
    category: "Airspace closure / FIR restriction",
    severity: "critical",
    pattern:
      /(FIR\s+(CLSD|CLOSED|NOT AVBL|SUSPENDED))|(AIRSPACE\s+(CLSD|CLOSED|SUSPENDED|RESTRICTED))|(ATS\s+ROUTES?\s+(CLSD|CLOSED|NOT AVBL))/i,
    meaning: "Part or all of Kuwait-controlled airspace is closed or restricted.",
    impact: "Widespread cancellations, diversions and long delays are likely.",
    advice: "Do not travel to the airport before confirming your flight with the airline.",
  },
  {
    category: "Airport closure",
    severity: "critical",
    pattern: /(AD\s+(CLSD|CLOSED))|(AERODROME\s+(CLSD|CLOSED))|(A(IR)?P(OR)?T\s+(CLSD|CLOSED))/i,
    meaning: "Kuwait International Airport is closed to some or all traffic.",
    impact: "Flights will not operate normally while the closure is active.",
    advice: "Check your airline before travelling; expect cancellations or diversions.",
  },
  {
    category: "Conflict / military hazard",
    severity: "critical",
    pattern:
      /(MISSILE|ROCKET|DRONE|UAS|UAV|GUN\s?FIR(E|ING)|MIL(ITARY)?\s+(OPS|EXER|ACT)|DANGER\s+AREA\s+ACT|PROHIBITED\s+AREA\s+ACT|CONFLICT|HOSTILIT)/i,
    meaning: "A military, drone or conflict-related hazard affects the area.",
    impact: "Airlines may reroute, delay, divert or cancel flights at short notice.",
    advice: "Monitor official DGCA and airline channels closely before travelling.",
  },
  {
    category: "GPS / GNSS interference",
    severity: "major",
    pattern: /(GPS|GNSS)\s*(RAIM)?.{0,40}(UNRELIABLE|INTERFER|JAM|OUTAGE|DEGRAD|NOT AVBL|SPOOF)/i,
    meaning: "Satellite navigation signals are unreliable in the region.",
    impact: "Aircraft use backup navigation; delays or reroutes are possible.",
    advice: "Expect possible schedule changes; flights normally continue with other navigation aids.",
  },
  {
    category: "Runway closure",
    severity: "major",
    pattern: /RWY\s*[0-9LRC/\s]*\s*(CLSD|CLOSED|NOT AVBL)/i,
    meaning: "A runway at Kuwait International is closed.",
    impact: "Reduced capacity can cause knock-on delays, especially at peak times.",
    advice: "Allow extra time and check your flight status before leaving.",
  },
  {
    category: "ATC / radar / communications outage",
    severity: "major",
    pattern:
      /(RADAR\s+(U\/S|UNSERVICEABLE|OUT|NOT AVBL))|(ATC\s+(SVC|SERVICE).{0,20}(LIMITED|NOT AVBL|U\/S))|(FREQ(UENCY)?\s+.{0,20}(U\/S|NOT AVBL))|(COM(M|MUNICATIONS?)?\s+FAIL)/i,
    meaning: "Air-traffic control, radar or radio services are degraded.",
    impact: "Flow restrictions and delays are possible while capacity is reduced.",
    advice: "Check for delay notices from your airline.",
  },
  {
    category: "Navigation aid outage",
    severity: "major",
    pattern: /(ILS|VOR|DME|NDB)\s+.{0,30}(U\/S|UNSERVICEABLE|NOT AVBL|OUT OF SERVICE)/i,
    meaning: "A landing or navigation aid at the airport is out of service.",
    impact: "Mostly handled routinely, but bad weather could then cause diversions.",
    advice: "No action needed unless weather is poor; check status before travelling.",
  },
];

/** Routine notices that must NOT clutter the public dashboard. */
const ROUTINE_PATTERN =
  /(CRANE|OBST(ACLE)?\s+(ERECTED|LGT)|OIL\s?RIG|RIG\s+(POSITION|ERECTED)|PARKING\s+STAND|STANDS?\s+\d+\s*(CLSD|CLOSED)|APRON|TWY\s+[A-Z0-9]+\s*(CLSD|CLOSED|WIP)|TAXIWAY.{0,20}(WORK|WIP|CLSD)|CHART|AIP\s+(AMDT|SUP)|LGT\s+(U\/S|UNSERVICEABLE)|LIGHTING.{0,20}(U\/S|UNSERVICEABLE)|BIRD\s+(CONC|ACTIVITY)|TRIGGER\s+NOTAM|CHECKLIST)/i;

/**
 * Classify raw NOTAM text. Returns:
 *   { relevant, category, severity, meaning, impact, advice }
 * `relevant` is true only for notices worth showing to passengers.
 */
export function classifyNotam(text) {
  const t = (text || "").toUpperCase();
  if (!t.trim()) {
    return { relevant: false, category: "Unclassified", severity: "info" };
  }
  for (const rule of MAJOR_RULES) {
    if (rule.pattern.test(t)) {
      return {
        relevant: true,
        category: rule.category,
        severity: rule.severity,
        meaning: rule.meaning,
        impact: rule.impact,
        advice: rule.advice,
      };
    }
  }
  if (ROUTINE_PATTERN.test(t)) {
    return { relevant: false, category: "Routine notice", severity: "info" };
  }
  // Unmatched notices stay hidden from the public list but still feed the
  // airspace engine (which only reacts to the explicit rules above anyway).
  return { relevant: false, category: "Other", severity: "info" };
}

/** Convert one FAA NOTAM Search record into a dashboard notice card. */
export function simplifyNotam(raw, nowIso = new Date().toISOString()) {
  const text = sanitizeText(
    raw.icaoMessage || raw.traditionalMessage || raw.notamText || raw.text,
    2_000,
  );
  const classification = classifyNotam(text || "");
  return {
    id: sanitizeText(raw.notamNumber || raw.notamId || raw.id, 40) || `notam-${hashText(text || "")}`,
    reference: sanitizeText(raw.notamNumber || raw.notamId, 40) || "(unnumbered)",
    location: sanitizeText(raw.facilityDesignator || raw.icaoLocation, 8) || "OKKK",
    category: classification.category,
    severity: classification.severity,
    relevant: classification.relevant,
    meaning: classification.meaning || null,
    impact: classification.impact || null,
    advice: classification.advice || null,
    effectiveFrom: sanitizeText(raw.startDate, 40),
    effectiveTo: sanitizeText(raw.endDate, 40),
    text,
    url: safeHttpUrl(raw.url) || NOTAM_SOURCE.publicUrl,
    retrievedAt: nowIso,
  };
}

/** Small deterministic hash for stable IDs on unnumbered notices. */
function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * Fetch Kuwait NOTAMs. Returns every parsed notice (`all`) for airspace
 * analysis plus the passenger-relevant subset (`display`).
 */
export async function collectNotams() {
  const checkedAt = new Date().toISOString();
  const health = {
    id: "dgca-notams",
    name: NOTAM_SOURCE.sourceName,
    type: "NOTAM feed",
    url: NOTAM_SOURCE.publicUrl,
    checkedAt,
    status: "unavailable",
    records: null,
    message: null,
  };
  try {
    const body = new URLSearchParams({
      searchType: "0",
      designatorsForLocation: NOTAM_SOURCE.designators,
      latDegrees: "",
      longDegrees: "",
      radius: "10",
      sortColumns: "5 false",
      sortDirection: "true",
      offset: "0",
      notamsOnly: "false",
    });
    const response = await fetchWithTimeout(NOTAM_SOURCE.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        accept: "application/json",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      health.message = `NOTAM service responded HTTP ${response.status}`;
      return { ok: false, all: [], display: [], health };
    }
    const payload = await response.json();
    const list = Array.isArray(payload?.notamList) ? payload.notamList : [];
    const all = list.map((raw) => simplifyNotam(raw, checkedAt));
    const display = all
      .filter((n) => n.relevant)
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    health.status = "ok";
    health.records = all.length;
    health.message =
      all.length === 0 ? "NOTAM service reachable; no notices returned for OKKK/OKBK" : null;
    return { ok: true, all, display, health };
  } catch (error) {
    health.message =
      error?.name === "AbortError"
        ? "NOTAM service timed out"
        : `NOTAM retrieval failed: ${sanitizeText(error?.message, 160) || "unknown error"}`;
    return { ok: false, all: [], display: [], health };
  }
}

function severityRank(severity) {
  return severity === "critical" ? 2 : severity === "major" ? 1 : 0;
}
