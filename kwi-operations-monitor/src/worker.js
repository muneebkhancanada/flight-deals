/**
 * KWI Operations Monitor — Cloudflare Worker entry point.
 *
 * One Worker that:
 *   1. serves the static frontend (with cache-busting + security headers),
 *   2. serves the latest KV snapshot via JSON APIs (stale-while-revalidate),
 *   3. refreshes data in the background (on-demand + cron), and
 *   4. keeps serving the last good snapshot through upstream outages.
 *
 * /api/status NEVER performs a blocking multi-source refresh: it returns the
 * cached snapshot immediately and, when stale, kicks a guarded background
 * refresh via ctx.waitUntil().
 */

import { ASSET_VERSION, getConfig, SNAPSHOT_HARD_STALE_SECONDS } from "./config.js";
import { readSnapshot, readSnapshotMeta, startGuardedRefresh } from "./snapshot.js";
import { isAlertingConfigured } from "./alerts.js";
import { ageSeconds } from "./util.js";

const API_CACHE_CONTROL = "public, max-age=20, stale-while-revalidate=120";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
  // Everything is self-hosted; no inline script, no external requests.
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/status") return handleStatus(request, env, ctx);
      if (url.pathname === "/api/health") return handleHealth(env);
      if (url.pathname === "/api/refresh") return handleManualRefresh(request, env, ctx);
      if (url.pathname.startsWith("/api/")) {
        return jsonResponse({ error: "Not found" }, 404);
      }
      return serveAsset(request, env);
    } catch (error) {
      console.error("Unhandled worker error:", error?.stack || error);
      return jsonResponse({ error: "Internal error" }, 500);
    }
  },

  /** Cron trigger — same guarded refresh path as on-demand revalidation. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(startGuardedRefresh(env, "cron"));
  },
};

/** GET /api/status — cached snapshot immediately; background refresh if stale. */
async function handleStatus(_request, env, ctx) {
  const config = getConfig(env);
  const snapshot = await readSnapshot(env);

  if (!snapshot) {
    // First boot: no snapshot yet. Kick a refresh and return an honest
    // "initialising" payload — a 200, never a 503.
    ctx.waitUntil(startGuardedRefresh(env, "bootstrap"));
    return jsonResponse(bootstrapSnapshot(config), 200, {
      "cache-control": "no-store",
    });
  }

  const age = ageSeconds(snapshot.meta?.generatedAt) ?? Number.POSITIVE_INFINITY;
  if (age > config.refreshSeconds) {
    ctx.waitUntil(startGuardedRefresh(env, "stale-while-revalidate"));
  }
  snapshot.meta = snapshot.meta || {};
  snapshot.meta.snapshotAgeSeconds = age === Number.POSITIVE_INFINITY ? null : age;
  return jsonResponse(snapshot, 200, { "cache-control": API_CACHE_CONTROL });
}

/** GET /api/health — lightweight: reads only the small meta blob from KV. */
async function handleHealth(env) {
  let kvAvailable = true;
  let meta = null;
  try {
    meta = await readSnapshotMeta(env);
  } catch {
    kvAvailable = false;
  }
  const body = {
    worker: "ok",
    kvAvailable,
    snapshotAgeSeconds: meta ? ageSeconds(meta.generatedAt) : null,
    snapshotStale: meta ? (ageSeconds(meta.generatedAt) ?? Infinity) > SNAPSHOT_HARD_STALE_SECONDS : null,
    lastRefreshAttempt: meta?.lastRefreshAttempt || null,
    lastRefreshError: meta?.lastRefreshError || null,
    dataMode: meta?.dataMode || "no-snapshot",
    flightCount: meta?.flightCount ?? null,
    // Admin-facing note only; the public dashboard never surfaces this.
    alerting: isAlertingConfigured(env) ? "configured" : "not-configured",
  };
  return jsonResponse(body, 200, { "cache-control": "no-store" });
}

/**
 * POST /api/refresh — manual refresh, protected by the ADMIN_TOKEN secret.
 * Responds 404 when no token is configured so the route stays invisible.
 */
async function handleManualRefresh(request, env, ctx) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!env.ADMIN_TOKEN) return jsonResponse({ error: "Not found" }, 404);
  const provided = request.headers.get("authorization") || "";
  if (!timingSafeEqual(provided, `Bearer ${env.ADMIN_TOKEN}`)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  ctx.waitUntil(startGuardedRefresh(env, "manual"));
  return jsonResponse({ ok: true, message: "Background refresh started" }, 202, {
    "cache-control": "no-store",
  });
}

/** Constant-time-ish comparison to avoid trivially timing the admin token. */
function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

/**
 * Serve static assets through the ASSETS binding. index.html gets the
 * asset-version placeholder replaced (cache busting) and every response gets
 * the security headers.
 */
async function serveAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const html = (await response.text()).replaceAll("__ASSET_VERSION__", ASSET_VERSION);
    return withHeaders(
      new Response(html, { status: response.status, headers: response.headers }),
      { ...SECURITY_HEADERS, "cache-control": "public, max-age=60" },
    );
  }
  // Versioned assets (app.js?v=..., styles.css?v=...) can cache long.
  const url = new URL(request.url);
  const cacheControl = url.searchParams.has("v")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300";
  return withHeaders(new Response(response.body, response), {
    ...SECURITY_HEADERS,
    "cache-control": cacheControl,
  });
}

function withHeaders(response, headers) {
  const out = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) out.headers.set(key, value);
  return out;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

/** Honest first-boot payload shown while the very first refresh runs. */
function bootstrapSnapshot(config) {
  const nowIso = new Date().toISOString();
  return {
    meta: {
      generatedAt: nowIso,
      lastSuccessfulRefresh: null,
      lastRefreshAttempt: nowIso,
      lastRefreshError: null,
      dataMode: "initialising",
      window: { historyHours: config.historyHours, futureHours: config.futureHours },
      snapshotAgeSeconds: 0,
    },
    airspace: {
      status: "unknown",
      confidence: "low",
      reason: "The monitor is collecting its first data snapshot. Refresh in about a minute.",
      source: "Initialising",
      sourceUrl: null,
      updatedAt: nowIso,
    },
    summary: {
      arrivals: 0,
      departures: 0,
      delayed: 0,
      delayedTwoHours: 0,
      cancelled: 0,
      diverted: 0,
      priorityAffected: 0,
    },
    flights: [],
    notices: [],
    advisories: [],
    social: [],
    sourceHealth: [],
  };
}
