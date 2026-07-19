/**
 * Central configuration for the KWI Operations Monitor.
 *
 * Everything here is non-secret. Secrets (KWI_API_AUTH, X_BEARER_TOKEN,
 * RESEND_API_KEY, ADMIN_TOKEN) are provided via Cloudflare secrets and read
 * from `env` at runtime — never from this file.
 */

/**
 * Bump this when public/app.js or public/styles.css change.
 * The Worker injects it into index.html as a cache-busting query string
 * (?v=...), so browsers pick up new frontend assets immediately.
 */
export const ASSET_VERSION = "1.0.0";

/** Kuwait has a fixed UTC+3 offset with no daylight saving time. */
export const KUWAIT_UTC_OFFSET = "+03:00";

/**
 * ICAO airline designator → IATA designator, for normalising flight numbers
 * into the passenger-recognisable form (KAC374 → KU374). Identifiers with no
 * mapping are preserved as-is.
 */
export const AIRLINE_ICAO_TO_IATA = {
  KAC: "KU", // Kuwait Airways
  JZR: "J9", // Jazeera Airways
  MSR: "MS", // EgyptAir
  UAE: "EK", // Emirates
  FDB: "FZ", // flydubai
};

/**
 * Airlines the dashboard highlights. Matching is done against the airline
 * name and against both ICAO and IATA codes.
 */
export const PRIORITY_AIRLINES = [
  { name: "Kuwait Airways", codes: ["KAC", "KU"] },
  { name: "Jazeera Airways", codes: ["JZR", "J9"] },
  { name: "EgyptAir", codes: ["MSR", "MS"] },
  { name: "Emirates", codes: ["UAE", "EK"] },
  { name: "flydubai", codes: ["FDB", "FZ"] },
];

/** Official KWI combined arrivals + departures JSON API. */
export const KWI_FLIGHTS_API = {
  url: "https://www.kuwaitairport.gov.kw/api/flights",
  referer:
    "https://www.kuwaitairport.gov.kw/en/flights-info/flight-status/arrivals/",
  publicUrl: "https://www.kuwaitairport.gov.kw/en/flights-info/flight-status/arrivals/",
  sourceName: "Kuwait International Airport",
};

/**
 * NOTAM retrieval. The FAA external NOTAM search covers foreign locations
 * including Kuwait (OKKK = Kuwait FIR, OKKK/OKBK aerodrome) and needs no
 * credential. It is best-effort: when it is unreachable the dashboard keeps
 * the last snapshot and marks the source degraded.
 */
export const NOTAM_SOURCE = {
  url: "https://notams.aim.faa.gov/notamSearch/search",
  designators: "OKBK,OKKK",
  publicUrl: "https://www.dgca.gov.kw",
  sourceName: "Kuwait DGCA NOTAMs (via FAA NOTAM Search)",
};

/**
 * Airline advisory pages, checked for Kuwait-related operational notices.
 * Add more airlines here — each entry is fetched independently and a failure
 * never breaks the refresh. `keywords` narrows what counts as relevant.
 */
export const ADVISORY_SOURCES = [
  {
    id: "kuwait-airways",
    airline: "Kuwait Airways",
    url: "https://www.kuwaitairways.com/en/pages/travel-alerts",
    priority: true,
  },
  {
    id: "jazeera-airways",
    airline: "Jazeera Airways",
    url: "https://www.jazeeraairways.com/en-kw/travel-updates",
    priority: true,
  },
  {
    id: "egyptair",
    airline: "EgyptAir",
    url: "https://www.egyptair.com/en/about-egyptair/news-and-press/Pages/default.aspx",
    priority: true,
  },
  {
    id: "emirates",
    airline: "Emirates",
    url: "https://www.emirates.com/us/english/help/travel-updates/",
    priority: true,
  },
  {
    id: "flydubai",
    airline: "flydubai",
    url: "https://www.flydubai.com/en/plan/travel-updates",
    priority: true,
  },
  {
    id: "kuwait-dgca",
    airline: "Kuwait DGCA (government)",
    url: "https://www.dgca.gov.kw",
    government: true,
  },
];

/** Keywords that mark an advisory page section as relevant to KWI. */
export const ADVISORY_KEYWORDS = [
  "kuwait",
  "kwi",
  "airspace",
  "suspend",
  "suspension",
  "cancel",
  "cancellation",
  "closure",
  "closed",
  "resumption",
  "diverted",
  "disruption",
];

/**
 * Official X (Twitter) accounts monitored when X_BEARER_TOKEN is configured.
 * These are also surfaced as plain links in the sources section regardless
 * of whether the X API is configured.
 */
export const X_ACCOUNTS = [
  { username: "Kuwait_DGCA", label: "Kuwait DGCA", kind: "government" },
  { username: "KuwaitAirways", label: "Kuwait Airways", kind: "airline" },
  { username: "JazeeraAirways", label: "Jazeera Airways", kind: "airline" },
  { username: "kuna_en", label: "KUNA (Kuwait News Agency)", kind: "government" },
  { username: "Moi_kuw", label: "Kuwait Ministry of Interior", kind: "government" },
  { username: "CGCKuwait", label: "Kuwait Civil Aviation (CGC)", kind: "government" },
  { username: "MOFAKuwait", label: "Kuwait Ministry of Foreign Affairs", kind: "government" },
  { username: "EGYPTAIR", label: "EgyptAir", kind: "airline" },
  { username: "emirates", label: "Emirates", kind: "airline" },
  { username: "flydubai", label: "flydubai", kind: "airline" },
];

/** KV keys used by the Worker. */
export const KV_KEYS = {
  snapshot: "snapshot:latest",
  meta: "snapshot:meta", // small metadata blob so /api/health stays lightweight
  alertState: "alerts:state",
};

/** Per-request network timeout (ms) applied with AbortController. */
export const FETCH_TIMEOUT_MS = 10_000;

/** How long a snapshot stays "fresh" before cron is considered overdue. */
export const SNAPSHOT_HARD_STALE_SECONDS = 30 * 60;

/**
 * Runtime configuration derived from Worker vars, with safe defaults so the
 * Worker functions even when a var is missing.
 */
export function getConfig(env = {}) {
  return {
    refreshSeconds: intVar(env.ON_DEMAND_REFRESH_SECONDS, 90),
    historyHours: intVar(env.FLIGHT_HISTORY_HOURS, 12),
    futureHours: intVar(env.FLIGHT_FUTURE_HOURS, 96),
    timezone: env.KWI_TIMEZONE || "Asia/Kuwait",
  };
}

function intVar(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
