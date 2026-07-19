/**
 * Acceptance / validation tests for the KWI Operations Monitor.
 * Plain Node — no test framework required. Run: npm test
 *
 * Covers the automatable acceptance scenarios: parsing, flight-number
 * normalisation, placeholder handling, display rules, colour rules, window
 * filtering, NOTAM filtering, airspace determination, degraded-source
 * behaviour, optional-X behaviour, alert deduplication, and a scan proving
 * no secret names leak into frontend files.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseKwiFlightRecord,
  parseKwiPayload,
  normalizeFlightNumber,
} from "../src/sources/kwiFlights.js";
import { dedupeFlights, filterFlightWindow, summarizeFlights } from "../src/flights.js";
import { deriveDisplay } from "../src/presentation.js";
import { classifyNotam } from "../src/sources/notams.js";
import { determineAirspace, buildFlightEvidence } from "../src/airspace.js";
import { buildSnapshotData } from "../src/snapshot.js";
import { computeAlertEvents, fingerprintEvent } from "../src/alerts.js";
import { collectSocialPosts } from "../src/sources/social.js";
import { isPlaceholderMidnight, kuwaitLocalToUtc } from "../src/util.js";
import { getConfig } from "../src/config.js";
import workerModule from "../src/worker.js";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
let passes = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passes += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- fixtures

const arrivalRecord = {
  flightDate: "2026-07-19T06:30:00",
  lastUpdate: "2026-07-19T03:51:00",
  departure: null,
  arrival: {
    routes: [
      { airportName: "Rajiv Gandhi International Airport", airportCode: "HYD", city: "Hyderabad", country: "India" },
    ],
    flightId: "arr_1817451",
    flightStatus: { Id: 1, status: "Delayed" },
    terminal: "T4",
    gate: "50B",
    scheduled: "2026-07-19T06:30:00",
    estimated: "2026-07-19T07:33:00",
    actual: "2026-07-19T00:00:00", // midnight placeholder → must become null
  },
  airline: { name: "Kuwait Airways", number: "374", iata: "KAC374", code: "KAC" },
};

const departureRecord = {
  flightDate: "2026-07-19T10:00:00",
  lastUpdate: "2026-07-19T08:00:00",
  arrival: null,
  departure: {
    routes: [{ airportName: "Dubai International", airportCode: "DXB", city: "Dubai", country: "UAE" }],
    flightId: "dep_900001",
    flightStatus: { Id: 2, status: "On Time" },
    terminal: "T1",
    gate: "12",
    scheduled: "2026-07-19T10:00:00",
    estimated: "2026-07-19T10:05:00",
    actual: "2026-07-19T00:00:00",
  },
  airline: { name: "Emirates", number: "856", iata: "UAE856", code: "UAE" },
};

function flightFixture(overrides = {}) {
  return {
    id: "t1",
    direction: "departure",
    flightNumber: "KU101",
    airline: "Kuwait Airways",
    origin: "KWI",
    destination: "LHR",
    routeLabel: "Kuwait → London",
    scheduledUtc: "2026-07-19T14:00:00.000Z",
    estimatedUtc: null,
    actualUtc: null,
    scheduledLocal: "17:00",
    scheduledLocalDate: "Sun 19 Jul",
    estimatedLocal: null,
    actualLocal: null,
    status: "Scheduled",
    delayMinutes: null,
    cancelled: false,
    diverted: false,
    terminal: "T1",
    gate: "5",
    priority: true,
    source: "Kuwait International Airport",
    sourceUrl: "https://www.kuwaitairport.gov.kw/",
    lastUpdated: null,
    ...overrides,
  };
}

// ------------------------------------------------- 1–2: nested record parsing

console.log("\nParsing");
const arr = parseKwiFlightRecord(arrivalRecord);
check("1. nested arrival parses", Boolean(arr) && arr.direction === "arrival");
check("1a. arrival origin/destination", arr.origin === "HYD" && arr.destination === "KWI");
check("1b. arrival route label", arr.routeLabel === "Hyderabad → Kuwait", arr.routeLabel);
check("1c. terminal + gate", arr.terminal === "T4" && arr.gate === "50B");
check(
  "1d. Kuwait local → UTC conversion",
  arr.scheduledUtc === "2026-07-19T03:30:00.000Z",
  String(arr.scheduledUtc),
);
check("1e. estimated parsed", arr.estimatedUtc === "2026-07-19T04:33:00.000Z");
check("1f. delay computed from estimate", arr.delayMinutes === 63, String(arr.delayMinutes));

const dep = parseKwiFlightRecord(departureRecord);
check("2. nested departure parses", Boolean(dep) && dep.direction === "departure");
check("2a. departure route label", dep.routeLabel === "Kuwait → Dubai", dep.routeLabel);
check("2b. departure origin/destination", dep.origin === "KWI" && dep.destination === "DXB");

const payload = parseKwiPayload({ result: [arrivalRecord, departureRecord] });
check("payload parse ok", payload.ok && payload.flights.length === 2);
const brokenPayload = parseKwiPayload({ unexpected: true });
check("broken payload reports failure (not zero flights)", brokenPayload.ok === false);
const driftedPayload = parseKwiPayload({ result: [{ junk: 1 }, { junk: 2 }] });
check("drifted payload reports failure", driftedPayload.ok === false);

// -------------------------------------------------- 3: midnight placeholder

console.log("\nPlaceholder times");
check("3. placeholder midnight actual → null", arr.actualUtc === null);
check("3a. isPlaceholderMidnight detects", isPlaceholderMidnight("2026-07-19T00:00:00"));
check("3b. real time not treated as placeholder", !isPlaceholderMidnight("2026-07-19T00:01:00"));
check(
  "3c. scheduled midnight is NOT nulled",
  kuwaitLocalToUtc("2026-07-20T00:00:00") === "2026-07-19T21:00:00.000Z",
);

// -------------------------------------------- 4: flight number normalisation

console.log("\nFlight numbers");
check("4. KAC → KU", normalizeFlightNumber({ code: "KAC", number: "374", iata: "KAC374" }) === "KU374");
check("4a. JZR → J9", normalizeFlightNumber({ code: "JZR", number: "125", iata: "JZR125" }) === "J9125");
check("4b. MSR → MS", normalizeFlightNumber({ code: "MSR", number: "610", iata: "MSR610" }) === "MS610");
check("4c. UAE → EK", normalizeFlightNumber({ code: "UAE", number: "856", iata: "UAE856" }) === "EK856");
check("4d. FDB → FZ", normalizeFlightNumber({ code: "FDB", number: "53", iata: "FDB053" }) === "FZ53");
check(
  "4e. unmapped identifier preserved",
  normalizeFlightNumber({ code: "QTR", number: "1076", iata: "QTR1076" }) === "QTR1076",
);

// ------------------------------------------------ 5–9: display/colour rules

console.log("\nStatus display rules");
const departedLate = deriveDisplay(
  flightFixture({
    status: "Departed",
    actualUtc: "2026-07-19T15:05:00.000Z",
    actualLocal: "18:05",
    delayMinutes: 40,
  }),
);
check("5. departed-late primary", departedLate.primary === "Departed 18:05", departedLate.primary);
check("5a. departed-late secondary", departedLate.secondary === "40 min late");
check("5b. departed-late amber", departedLate.tone === "amber");
check("5c. time label = actual departure", departedLate.timeLabel === "Actual departure");

const arrivedVeryLate = deriveDisplay(
  flightFixture({
    direction: "arrival",
    status: "Arrived",
    actualUtc: "2026-07-19T19:15:00.000Z",
    actualLocal: "22:15",
    delayMinutes: 155,
  }),
);
check("6. arrived-very-late primary", arrivedVeryLate.primary === "Arrived 22:15", arrivedVeryLate.primary);
check("6a. arrived-very-late secondary", arrivedVeryLate.secondary === "2h 35m late");
check("6b. ≥2h late is red", arrivedVeryLate.tone === "red");

const onTimeCompleted = deriveDisplay(
  flightFixture({ status: "Departed", actualUtc: "2026-07-19T14:02:00.000Z", actualLocal: "17:02", delayMinutes: 2 }),
);
check("7. on-time completed is green", onTimeCompleted.tone === "green");
check("7a. on-time completed shows Departed", onTimeCompleted.primary === "Departed 17:02");

const currentlyDelayed = deriveDisplay(
  flightFixture({
    status: "Delayed",
    estimatedUtc: "2026-07-19T15:20:00.000Z",
    estimatedLocal: "18:20",
    delayMinutes: 80,
  }),
);
check("8. currently delayed is amber", currentlyDelayed.tone === "amber");
check("8a. delayed primary includes duration", currentlyDelayed.primary === "Delayed 1h 20m", currentlyDelayed.primary);
check("8b. delayed secondary shows estimate", currentlyDelayed.secondary === "Estimated departure 18:20");

check("9. cancelled is red", deriveDisplay(flightFixture({ cancelled: true, status: "Cancelled" })).tone === "red");
check("9a. diverted is red", deriveDisplay(flightFixture({ diverted: true, status: "Diverted" })).tone === "red");
check(
  "late-but-departed never green",
  deriveDisplay(flightFixture({ status: "Departed", actualUtc: "2026-07-19T15:05:00.000Z", actualLocal: "18:05", delayMinutes: 40 })).tone !== "green",
);
check("neutral for unknown", deriveDisplay(flightFixture({ status: "Unknown", scheduledUtc: null })).tone === "neutral");

// ------------------------------------------------ 10–11: time window filter

console.log("\nTime window");
const now = "2026-07-19T12:00:00.000Z";
const windowed = filterFlightWindow(
  [
    flightFixture({ id: "old", actualUtc: "2026-07-18T22:00:00.000Z", status: "Departed" }), // 14h ago
    flightFixture({ id: "recent", actualUtc: "2026-07-19T05:00:00.000Z", status: "Departed" }), // 7h ago
    flightFixture({ id: "far-future", scheduledUtc: "2026-07-24T13:00:00.000Z" }), // 121h ahead
    flightFixture({ id: "near-future", scheduledUtc: "2026-07-21T12:00:00.000Z" }), // 48h ahead
    flightFixture({
      id: "slipped-active",
      scheduledUtc: "2026-07-18T23:00:00.000Z", // 13h ago — outside window
      estimatedUtc: "2026-07-19T13:00:00.000Z", // but still expected to move
      status: "Delayed",
    }),
  ],
  now,
  { historyHours: 12, futureHours: 96 },
);
const ids = windowed.map((f) => f.id);
check("10. completed >12h ago excluded", !ids.includes("old"), ids.join(","));
check("10a. completed within 12h kept", ids.includes("recent"));
check("11. beyond 96h excluded", !ids.includes("far-future"));
check("11a. within 96h kept", ids.includes("near-future"));
check("still-active slipped flight kept", ids.includes("slipped-active"));

// --------------------------------------------------- 12–13: NOTAM filtering

console.log("\nNOTAM classification");
check("12. crane notice hidden", classifyNotam("CRANE ERECTED 500M NORTH OF RWY 15R HGT 45M AGL").relevant === false);
check(
  "12a. taxiway work hidden",
  classifyNotam("TWY B3 CLSD DUE WIP").relevant === false,
);
check("12b. oil rig hidden", classifyNotam("OIL RIG POSITION 2915N 04830E").relevant === false);
check("12c. parking stand hidden", classifyNotam("PARKING STAND 23 CLSD").relevant === false);
const fir = classifyNotam("KUWAIT FIR CLSD FOR ALL TFC DUE TO MILITARY ACTIVITY");
check("13. FIR closure shown", fir.relevant === true && fir.severity === "critical", fir.category);
const gps = classifyNotam("GPS RAIM UNRELIABLE DUE TO INTERFERENCE WI KUWAIT FIR");
check("13a. GPS interference shown", gps.relevant === true, gps.category);
check("13b. runway closure shown", classifyNotam("RWY 15L/33R CLSD DUE MAINT").relevant === true);
check(
  "13c. drone hazard shown as critical",
  classifyNotam("DRONE ACTIVITY REPORTED VICINITY OKBK").severity === "critical",
);

// ------------------------------------------------ 14–15: airspace determination

console.log("\nAirspace determination");
const closedAirspace = determineAirspace({
  notams: [
    { category: "Airspace closure / FIR restriction", reference: "A0123/26", meaning: "FIR closed.", url: "https://www.dgca.gov.kw" },
  ],
  flightEvidence: { sourceOk: true, totalFlights: 10, recentMovements: 0 },
  advisories: [],
  nowIso: now,
});
check("15. closure NOTAM → closed/high", closedAirspace.status === "closed" && closedAirspace.confidence === "high");

const openAirspace = determineAirspace({
  notams: [],
  flightEvidence: { sourceOk: true, totalFlights: 40, recentMovements: 9 },
  advisories: [],
  nowIso: now,
});
check("14. active flights + no closure → open", openAirspace.status === "open");

const brokenFeedAirspace = determineAirspace({
  notams: [],
  flightEvidence: { sourceOk: false, totalFlights: 0, recentMovements: 0 },
  advisories: [],
  nowIso: now,
});
check(
  "16-pre. broken feed → unknown, NOT closed",
  brokenFeedAirspace.status === "unknown" && /does not mean/i.test(brokenFeedAirspace.reason),
);
const evidence = buildFlightEvidence(
  [flightFixture({ actualUtc: "2026-07-19T10:00:00.000Z" })],
  true,
  now,
);
check("flight evidence counts recent movements", evidence.recentMovements === 1);

// ------------------------------------- 16: degraded source ≠ zero flights

console.log("\nDegraded-source behaviour");
const config = getConfig({});
const previousSnapshot = {
  flights: [flightFixture({ id: "cached-1", scheduledUtc: "2026-07-19T15:00:00.000Z" })],
  notices: [],
  social: [],
  meta: { lastSuccessfulRefresh: "2026-07-19T11:00:00.000Z" },
};
const degradedSnapshot = buildSnapshotData({
  now: new Date(now),
  config,
  kwiResult: { ok: false, flights: [], health: { id: "kwi-official-api", name: "KWI", type: "API", url: null, checkedAt: now, status: "unavailable", records: null, message: "HTTP 500" } },
  notamResult: { ok: true, all: [], display: [], health: { id: "dgca-notams", name: "NOTAMs", type: "feed", url: null, checkedAt: now, status: "ok", records: 0, message: null } },
  advisoryResult: { advisories: [], health: [] },
  socialResult: { configured: false, ok: false, posts: [], health: null },
  previousSnapshot,
});
check("16. failed source keeps cached flights", degradedSnapshot.flights.length === 1);
check("16a. dataMode marks degradation", degradedSnapshot.meta.dataMode === "cached-degraded");
check("16b. lastRefreshError recorded", /HTTP 500/.test(degradedSnapshot.meta.lastRefreshError || ""));
check(
  "16c. lastSuccessfulRefresh preserved",
  degradedSnapshot.meta.lastSuccessfulRefresh === "2026-07-19T11:00:00.000Z",
);

// ------------------------------------------- 17–18: optional X behaviour

console.log("\nOptional X module");
const noTokenResult = await collectSocialPosts({}, {});
check("17. missing token → not configured, no fetch", noTokenResult.configured === false && noTokenResult.posts.length === 0);
check(
  "17a. unconfigured X adds no health card / no posts",
  degradedSnapshot.social.length === 0 &&
    !degradedSnapshot.sourceHealth.some((h) => h && h.id === "x-official-posts"),
);
const configuredSnapshot = buildSnapshotData({
  now: new Date(now),
  config,
  kwiResult: { ok: true, flights: [flightFixture()], health: { id: "kwi-official-api", name: "KWI", type: "API", url: null, checkedAt: now, status: "ok", records: 1, message: null } },
  notamResult: { ok: true, all: [], display: [], health: { id: "dgca-notams", name: "NOTAMs", type: "feed", url: null, checkedAt: now, status: "ok", records: 0, message: null } },
  advisoryResult: { advisories: [], health: [] },
  socialResult: {
    configured: true,
    ok: true,
    posts: [{ id: "1", author: "Kuwait DGCA", username: "Kuwait_DGCA", time: now, text: "Airspace open", url: "https://x.com/Kuwait_DGCA/status/1", media: [], summary: "Airspace open", whyItMatters: "x", verification: "y" }],
    health: { id: "x-official-posts", name: "X", type: "social", url: null, checkedAt: now, status: "ok", records: 1, message: null },
  },
  previousSnapshot: null,
});
check("18. configured X data appears in snapshot", configuredSnapshot.social.length === 1);
check(
  "18a. configured X adds health card",
  configuredSnapshot.sourceHealth.some((h) => h && h.id === "x-official-posts"),
);

// ------------------------------------------------ dedupe + summary

console.log("\nDe-duplication & summary");
const dupes = dedupeFlights([
  flightFixture({ id: "a", source: "Fallback scraper" }),
  flightFixture({ id: "b", source: "Kuwait International Airport" }),
]);
check("official source wins dedupe", dupes.length === 1 && dupes[0].id === "b");
const summary = summarizeFlights([
  flightFixture({ status: "Delayed", delayMinutes: 30 }),
  flightFixture({ id: "x2", delayMinutes: 130 }),
  flightFixture({ id: "x3", cancelled: true, status: "Cancelled" }),
  flightFixture({ id: "x4", direction: "arrival" }),
]);
check(
  "summary counts",
  summary.departures === 3 && summary.arrivals === 1 && summary.delayed === 2 &&
    summary.delayedTwoHours === 1 && summary.cancelled === 1 && summary.priorityAffected === 3,
  JSON.stringify(summary),
);

// ------------------------------------------------ alert events + dedupe

console.log("\nAlerting");
const prevSnap = { flights: [flightFixture({ id: "f1", delayMinutes: 30 })], summary: { cancelled: 0, diverted: 0, delayedTwoHours: 0 }, airspace: { status: "open" } };
const newSnap = {
  flights: [flightFixture({ id: "f1", delayMinutes: 150, status: "Delayed" })],
  summary: { cancelled: 0, diverted: 0, delayedTwoHours: 1 },
  airspace: { status: "closed", reason: "test" },
  advisories: [],
};
const events = computeAlertEvents(prevSnap, newSnap);
check("delay crossing 2h alerts", events.some((e) => e.kind === "major-delay"));
check("airspace change alerts", events.some((e) => e.kind === "airspace-change"));
const again = computeAlertEvents(newSnap, newSnap);
check("unchanged state produces no repeat events", again.every((e) => e.kind !== "major-delay" && e.kind !== "airspace-change"));
check(
  "fingerprints stable for dedupe",
  fingerprintEvent(events[0]) === fingerprintEvent(computeAlertEvents(prevSnap, newSnap)[0]),
);

// ------------------------------------------------ 19–22: worker + security

console.log("\nWorker & security");
check("worker exports fetch + scheduled", typeof workerModule.fetch === "function" && typeof workerModule.scheduled === "function");

const publicDir = join(here, "..", "public");
const frontendFiles = ["index.html", "app.js", "styles.css"].map((f) =>
  readFileSync(join(publicDir, f), "utf8"),
);
const secretNames = ["KWI_API_AUTH", "X_BEARER_TOKEN", "RESEND_API_KEY", "ADMIN_TOKEN", "ALERT_EMAIL"];
check(
  "22. no secret names in frontend files",
  frontendFiles.every((content) => secretNames.every((s) => !content.includes(s))),
);
check(
  "22a. snapshot contains no env/secret fields",
  !JSON.stringify(configuredSnapshot).match(/KWI_API_AUTH|X_BEARER_TOKEN|RESEND_API_KEY|ADMIN_TOKEN/),
);
const indexHtml = frontendFiles[0];
check("24. cache-busting placeholders in index.html", (indexHtml.match(/__ASSET_VERSION__/g) || []).length >= 2);
check("23. responsive viewport meta present", indexHtml.includes('name="viewport"'));
const stylesCss = frontendFiles[2];
check("23a. mobile card layout present", stylesCss.includes("@media (max-width: 760px)"));

// ---------------------------------------------------------------- result

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
