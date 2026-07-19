/**
 * Optional email alerting (Resend, or any compatible HTTP email API).
 *
 * Enabled only when RESEND_API_KEY, ALERT_EMAIL_TO and ALERT_EMAIL_FROM are
 * all configured. When absent the dashboard works normally and delivery is
 * marked "not configured" in health metadata only — never as a public error.
 *
 * De-duplication: every alert event has a deterministic fingerprint that is
 * remembered in KV, so an unchanged condition never re-alerts.
 */

import { KV_KEYS } from "./config.js";
import { fetchWithTimeout, formatDuration, sanitizeText } from "./util.js";

const RESEND_URL = "https://api.resend.com/emails";
/** Fingerprints are kept this long, then forgotten (events expire naturally). */
const STATE_TTL_SECONDS = 3 * 24 * 3600;
/** "Unusually broad rise": disrupted count grows by ≥5 AND at least doubles. */
const BROAD_RISE_MIN_INCREASE = 5;

export function isAlertingConfigured(env = {}) {
  return Boolean(env.RESEND_API_KEY && env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM);
}

/** Stable per-event identity used to suppress repeats. */
export function fingerprintEvent(event) {
  return [event.kind, event.flightId || event.scope || "", event.detail || ""].join("|");
}

/**
 * Compare the previous and new snapshots and produce alertable events.
 * Pure function — exported for tests.
 */
export function computeAlertEvents(prevSnapshot, newSnapshot) {
  const events = [];
  const prevFlights = new Map(
    (prevSnapshot?.flights || []).map((f) => [f.id, f]),
  );

  for (const flight of newSnapshot?.flights || []) {
    const prev = prevFlights.get(flight.id);
    const base = {
      flightId: flight.id,
      flightNumber: flight.flightNumber,
      airline: flight.airline,
      route: flight.routeLabel,
      scheduledLocal: `${flight.scheduledLocalDate || ""} ${flight.scheduledLocal || ""}`.trim(),
      status: flight.status,
    };
    if (flight.cancelled && !prev?.cancelled) {
      events.push({ ...base, kind: "cancellation", detail: "cancelled", changed: "Flight was cancelled" });
    } else if (flight.diverted && !prev?.diverted) {
      events.push({ ...base, kind: "diversion", detail: "diverted", changed: "Flight was diverted" });
    } else if ((flight.delayMinutes ?? 0) >= 120 && (prev?.delayMinutes ?? 0) < 120) {
      events.push({
        ...base,
        kind: "major-delay",
        detail: "delay>=120",
        changed: `Delay reached ${formatDuration(flight.delayMinutes)}`,
        delay: formatDuration(flight.delayMinutes),
      });
    }
  }

  // Airspace / airport restriction changes.
  const prevAirspace = prevSnapshot?.airspace?.status;
  const newAirspace = newSnapshot?.airspace?.status;
  if (newAirspace && prevAirspace && newAirspace !== prevAirspace &&
      (newAirspace === "closed" || newAirspace === "restricted" || prevAirspace === "closed")) {
    events.push({
      kind: "airspace-change",
      scope: "airspace",
      detail: `${prevAirspace}->${newAirspace}`,
      changed: `Airspace status changed from ${prevAirspace} to ${newAirspace}`,
      status: newAirspace,
      reason: newSnapshot.airspace.reason,
    });
  }

  // Unusually broad rise in disruption.
  const disrupted = (s) =>
    (s?.summary?.cancelled ?? 0) + (s?.summary?.diverted ?? 0) + (s?.summary?.delayedTwoHours ?? 0);
  const prevCount = disrupted(prevSnapshot);
  const newCount = disrupted(newSnapshot);
  if (newCount - prevCount >= BROAD_RISE_MIN_INCREASE && newCount >= prevCount * 2) {
    events.push({
      kind: "broad-disruption",
      scope: "network",
      detail: `count=${newCount}`,
      changed: `Disrupted flights rose from ${prevCount} to ${newCount}`,
      status: "Multiple flights disrupted",
    });
  }

  // Airline suspension signals from advisories (government or airline).
  for (const advisory of newSnapshot?.advisories || []) {
    if (/suspend|suspension/i.test(advisory.excerpt || "")) {
      events.push({
        kind: "airline-suspension",
        scope: advisory.airline,
        detail: advisory.id,
        changed: `${advisory.airline} published a possible suspension notice`,
        status: "Advisory",
        reason: advisory.excerpt,
      });
    }
  }

  return events;
}

/** Render events into one plain-but-readable HTML email body. */
export function renderAlertEmail(events, snapshot) {
  const rows = events
    .map((e) => {
      const lines = [
        e.flightNumber ? `<strong>${esc(e.flightNumber)}</strong> — ${esc(e.airline || "")}` : `<strong>${esc(e.scope || e.kind)}</strong>`,
        e.route ? `Route: ${esc(e.route)}` : null,
        e.scheduledLocal ? `Scheduled (Kuwait time): ${esc(e.scheduledLocal)}` : null,
        `Current status: ${esc(e.status || "n/a")}`,
        `What changed: ${esc(e.changed)}`,
        e.delay ? `Delay: ${esc(e.delay)}` : null,
        e.reason ? `Details: ${esc(e.reason)}` : null,
      ].filter(Boolean);
      return `<li style="margin-bottom:12px">${lines.join("<br>")}</li>`;
    })
    .join("");

  const socialSummary = (snapshot?.social || [])
    .slice(0, 3)
    .map((p) => `<li>${esc(p.author)}: ${esc(p.summary || "")} <em>(${esc(p.verification || "unverified")})</em></li>`)
    .join("");

  return `
    <h2>KWI flight disruption alert</h2>
    <p>Kuwait International Airport Operations Monitor detected the following change(s):</p>
    <ul>${rows}</ul>
    ${socialSummary ? `<h3>Relevant official posts</h3><ul>${socialSummary}</ul>` : ""}
    <p>Airspace: ${esc(snapshot?.airspace?.status || "unknown")} — ${esc(snapshot?.airspace?.reason || "")}</p>
    <p>Sources: <a href="https://www.kuwaitairport.gov.kw/en/flights-info/flight-status/arrivals/">Kuwait International Airport</a> ·
       <a href="https://www.dgca.gov.kw">Kuwait DGCA</a></p>`;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Diff snapshots, drop already-sent events, send one combined email.
 * Returns a small status object stored in snapshot meta (admin-facing only).
 */
export async function processAlerts(env, prevSnapshot, newSnapshot) {
  if (!isAlertingConfigured(env)) {
    return { configured: false, sent: 0 };
  }
  const events = computeAlertEvents(prevSnapshot, newSnapshot);
  if (events.length === 0) return { configured: true, sent: 0 };

  let state = {};
  try {
    state = (await env.KWI_KV.get(KV_KEYS.alertState, "json")) || {};
  } catch {
    state = {};
  }
  const nowMs = Date.now();
  // Drop expired fingerprints, then filter out already-alerted events.
  for (const [key, ts] of Object.entries(state)) {
    if (nowMs - ts > STATE_TTL_SECONDS * 1000) delete state[key];
  }
  const fresh = events.filter((e) => !state[fingerprintEvent(e)]);
  if (fresh.length === 0) return { configured: true, sent: 0 };

  try {
    const response = await fetchWithTimeout(RESEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.ALERT_EMAIL_FROM,
        to: String(env.ALERT_EMAIL_TO).split(",").map((s) => s.trim()),
        subject: "KWI flight disruption alert",
        html: renderAlertEmail(fresh, newSnapshot),
      }),
    });
    if (!response.ok) {
      return { configured: true, sent: 0, error: `Email API responded HTTP ${response.status}` };
    }
    for (const event of fresh) state[fingerprintEvent(event)] = nowMs;
    await env.KWI_KV.put(KV_KEYS.alertState, JSON.stringify(state), {
      expirationTtl: STATE_TTL_SECONDS,
    });
    return { configured: true, sent: fresh.length };
  } catch (error) {
    return {
      configured: true,
      sent: 0,
      error: sanitizeText(error?.message, 160) || "Email delivery failed",
    };
  }
}
