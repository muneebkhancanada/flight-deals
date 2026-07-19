/**
 * Snapshot orchestration: collect all sources (isolated failures), build the
 * normalized snapshot, persist it to KV, and diff for alerts.
 *
 * Refreshes are guarded by an in-isolate promise so overlapping triggers
 * (cron + several stale /api/status hits) share a single refresh instead of
 * stampeding the upstream APIs or exhausting Worker CPU.
 */

import { KV_KEYS, getConfig } from "./config.js";
import { collectKwiFlights } from "./sources/kwiFlights.js";
import { collectNotams } from "./sources/notams.js";
import { collectAdvisories } from "./sources/advisories.js";
import { collectSocialPosts } from "./sources/social.js";
import { dedupeFlights, filterFlightWindow, summarizeFlights } from "./flights.js";
import { withDisplay } from "./presentation.js";
import { buildFlightEvidence, determineAirspace } from "./airspace.js";
import { processAlerts } from "./alerts.js";
import { sanitizeText } from "./util.js";

/** In-isolate refresh guard — one refresh at a time per Worker isolate. */
let activeRefreshPromise = null;

/**
 * Start (or join) a guarded background refresh. Always returns a promise
 * that resolves without throwing, so it is safe inside ctx.waitUntil().
 */
export function startGuardedRefresh(env, trigger = "on-demand") {
  if (!activeRefreshPromise) {
    activeRefreshPromise = runRefresh(env, trigger)
      .catch((error) => {
        // Never let a refresh rejection escape into waitUntil; record it.
        console.error("KWI refresh failed:", error?.stack || error);
        return recordRefreshError(env, error);
      })
      .finally(() => {
        activeRefreshPromise = null;
      });
  }
  return activeRefreshPromise;
}

/** Read the latest full snapshot from KV (null when none exists yet). */
export async function readSnapshot(env) {
  try {
    return await env.KWI_KV.get(KV_KEYS.snapshot, "json");
  } catch {
    return null;
  }
}

/** Read only the small metadata blob — used by /api/health. */
export async function readSnapshotMeta(env) {
  try {
    return await env.KWI_KV.get(KV_KEYS.meta, "json");
  } catch {
    return null;
  }
}

/**
 * Pure snapshot assembly from collected source results — exported separately
 * so tests can exercise degraded-source behaviour without any network.
 */
export function buildSnapshotData({
  now,
  config,
  kwiResult,
  notamResult,
  advisoryResult,
  socialResult,
  previousSnapshot,
}) {
  const nowIso = now.toISOString();
  const sourceHealth = [];

  // ---- Flights -----------------------------------------------------------
  let flights = kwiResult.flights;
  let dataMode = "official-live";
  if (!kwiResult.ok) {
    const previousFlights = previousSnapshot?.flights;
    if (Array.isArray(previousFlights) && previousFlights.length > 0) {
      // Serve the last good flight list rather than pretending the airport
      // is empty. dataMode tells the frontend to say "feed degraded".
      flights = previousFlights;
      dataMode = "cached-degraded";
    } else {
      flights = [];
      dataMode = "unavailable";
    }
  }
  sourceHealth.push(kwiResult.health);

  flights = withDisplay(
    filterFlightWindow(dedupeFlights(flights), nowIso, {
      historyHours: config.historyHours,
      futureHours: config.futureHours,
    }),
  );

  // ---- NOTAMs ------------------------------------------------------------
  sourceHealth.push(notamResult.health);
  const notices = notamResult.ok ? notamResult.display : previousSnapshot?.notices || [];
  const allNotams = notamResult.ok
    ? notamResult.all
    : previousSnapshot?.notices || []; // degraded: reuse last known notices for analysis

  // ---- Advisories --------------------------------------------------------
  sourceHealth.push(...advisoryResult.health);
  const advisories = advisoryResult.advisories;

  // ---- Social (optional) -------------------------------------------------
  // When X is not configured we add NOTHING: no posts, no health card, no
  // "not configured" warning — the tab simply does not exist for users.
  let social = [];
  if (socialResult.configured) {
    social = socialResult.ok ? socialResult.posts : previousSnapshot?.social || [];
    if (socialResult.health) sourceHealth.push(socialResult.health);
  }

  // ---- Airspace ----------------------------------------------------------
  const airspace = determineAirspace({
    notams: allNotams,
    flightEvidence: buildFlightEvidence(flights, kwiResult.ok, nowIso),
    advisories,
    nowIso,
  });

  const refreshErrors = sourceHealth
    .filter((h) => h && (h.status === "unavailable" || h.status === "degraded"))
    .map((h) => `${h.name}: ${h.message || h.status}`);

  return {
    meta: {
      generatedAt: nowIso,
      lastSuccessfulRefresh: kwiResult.ok
        ? nowIso
        : previousSnapshot?.meta?.lastSuccessfulRefresh || null,
      lastRefreshAttempt: nowIso,
      lastRefreshError: refreshErrors.length ? refreshErrors.join(" | ") : null,
      dataMode,
      window: { historyHours: config.historyHours, futureHours: config.futureHours },
    },
    airspace,
    summary: summarizeFlights(flights),
    flights,
    notices,
    advisories,
    social,
    sourceHealth,
  };
}

/** The actual refresh cycle. Sources are isolated via Promise.allSettled. */
async function runRefresh(env, trigger) {
  const now = new Date();
  const config = getConfig(env);
  const previousSnapshot = await readSnapshot(env);

  // The KWI payload is fetched exactly once here (arrivals + departures come
  // combined); nothing else re-requests or re-parses it.
  const [kwiSettled, notamSettled, advisorySettled] = await Promise.allSettled([
    collectKwiFlights(env, config),
    collectNotams(),
    collectAdvisories(),
  ]);

  const kwiResult =
    kwiSettled.status === "fulfilled"
      ? kwiSettled.value
      : failedSource("kwi-official-api", "Kuwait International Airport", kwiSettled.reason);
  const notamResult =
    notamSettled.status === "fulfilled"
      ? notamSettled.value
      : { ok: false, all: [], display: [], health: failedSource("dgca-notams", "Kuwait DGCA NOTAMs", notamSettled.reason).health };
  const advisoryResult =
    advisorySettled.status === "fulfilled"
      ? advisorySettled.value
      : { advisories: [], health: [] };

  // Social posts are cross-checked against flights + notices, so collect last.
  const socialResult = await collectSocialPosts(env, {
    flights: kwiResult.flights,
    notices: notamResult.display || [],
  });

  const snapshot = buildSnapshotData({
    now,
    config,
    kwiResult,
    notamResult,
    advisoryResult,
    socialResult,
    previousSnapshot,
  });
  snapshot.meta.refreshTrigger = trigger;

  await env.KWI_KV.put(KV_KEYS.snapshot, JSON.stringify(snapshot));
  await env.KWI_KV.put(
    KV_KEYS.meta,
    JSON.stringify({
      generatedAt: snapshot.meta.generatedAt,
      lastSuccessfulRefresh: snapshot.meta.lastSuccessfulRefresh,
      lastRefreshAttempt: snapshot.meta.lastRefreshAttempt,
      lastRefreshError: snapshot.meta.lastRefreshError,
      dataMode: snapshot.meta.dataMode,
      flightCount: snapshot.flights.length,
    }),
  );

  // Alerting runs after persistence; its failure must never lose a snapshot.
  try {
    const alertStatus = await processAlerts(env, previousSnapshot, snapshot);
    if (alertStatus.sent > 0) console.log(`KWI alerts sent: ${alertStatus.sent}`);
  } catch (error) {
    console.error("KWI alert processing failed:", error?.stack || error);
  }

  return snapshot;
}

function failedSource(id, name, reason) {
  return {
    ok: false,
    flights: [],
    health: {
      id,
      name,
      type: "Data source",
      url: null,
      checkedAt: new Date().toISOString(),
      status: "unavailable",
      records: null,
      message: sanitizeText(reason?.message, 160) || "Collector crashed unexpectedly",
    },
  };
}

/** Persist a refresh failure into the meta blob without touching the snapshot. */
async function recordRefreshError(env, error) {
  try {
    const meta = (await readSnapshotMeta(env)) || {};
    meta.lastRefreshAttempt = new Date().toISOString();
    meta.lastRefreshError = sanitizeText(error?.message, 200) || "Refresh failed";
    await env.KWI_KV.put(KV_KEYS.meta, JSON.stringify(meta));
  } catch {
    // KV itself unavailable — nothing more we can do; last snapshot persists.
  }
  return null;
}
