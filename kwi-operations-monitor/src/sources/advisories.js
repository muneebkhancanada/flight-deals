/**
 * Airline / government advisory monitoring.
 *
 * Each configured page is fetched independently with its own timeout; a
 * failing page marks only that source degraded and never breaks the refresh.
 * Parsing is intentionally light-touch (these are marketing CMS pages that
 * change layout freely): we extract visible text and look for Kuwait-related
 * disruption keywords, then surface a short excerpt around the first match.
 */

import { ADVISORY_KEYWORDS, ADVISORY_SOURCES } from "../config.js";
import { fetchWithTimeout, sanitizeText, safeHttpUrl } from "../util.js";

/** Strip an HTML document down to whitespace-collapsed visible text. */
export function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Scan page text for a disruption keyword near a Kuwait reference and return
 * an excerpt, or null when nothing Kuwait-relevant is found. Exported for
 * tests.
 */
export function findAdvisoryExcerpt(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const kuwaitIdx = lower.search(/kuwait|kwi\b/);
  if (kuwaitIdx === -1) return null;
  const disruptionWords = ADVISORY_KEYWORDS.filter((k) => k !== "kuwait" && k !== "kwi");
  // Look for a disruption keyword within ~400 chars of the Kuwait mention.
  const windowText = lower.slice(Math.max(0, kuwaitIdx - 400), kuwaitIdx + 400);
  const hit = disruptionWords.find((word) => windowText.includes(word));
  if (!hit) return null;
  const start = Math.max(0, kuwaitIdx - 120);
  return sanitizeText(text.slice(start, kuwaitIdx + 280), 400);
}

/** Check one advisory source; never throws. */
async function checkAdvisorySource(source) {
  const checkedAt = new Date().toISOString();
  const health = {
    id: `advisory-${source.id}`,
    name: `${source.airline} advisories`,
    type: source.government ? "Government notices page" : "Airline advisory page",
    url: source.url,
    checkedAt,
    status: "unavailable",
    records: null,
    message: null,
  };
  try {
    const response = await fetchWithTimeout(source.url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "KWI-Operations-Monitor/1.0 (public operational dashboard)",
      },
    });
    if (!response.ok) {
      health.status = "degraded";
      health.message = `Page responded HTTP ${response.status}`;
      return { advisory: null, health };
    }
    // Cap the amount of HTML processed so one huge page can't burn CPU.
    const html = (await response.text()).slice(0, 400_000);
    const excerpt = findAdvisoryExcerpt(htmlToText(html));
    health.status = "ok";
    health.records = excerpt ? 1 : 0;
    health.message = excerpt
      ? null
      : "Page reachable; no Kuwait-specific disruption notice detected";
    const advisory = excerpt
      ? {
          id: `advisory-${source.id}-${checkedAt.slice(0, 13)}`,
          airline: source.airline,
          title: `${source.airline}: possible Kuwait-related notice`,
          excerpt,
          url: safeHttpUrl(source.url),
          detectedAt: checkedAt,
          government: Boolean(source.government),
        }
      : null;
    return { advisory, health };
  } catch (error) {
    health.status = "unavailable";
    health.message =
      error?.name === "AbortError"
        ? "Page timed out"
        : `Fetch failed: ${sanitizeText(error?.message, 160) || "unknown error"}`;
    return { advisory: null, health };
  }
}

/**
 * Check every configured advisory page in parallel with per-source isolation
 * (Promise.allSettled), so one outage cannot affect the others.
 */
export async function collectAdvisories() {
  const results = await Promise.allSettled(ADVISORY_SOURCES.map(checkAdvisorySource));
  const advisories = [];
  const health = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      if (result.value.advisory) advisories.push(result.value.advisory);
      health.push(result.value.health);
    } else {
      health.push({
        id: `advisory-${ADVISORY_SOURCES[i].id}`,
        name: `${ADVISORY_SOURCES[i].airline} advisories`,
        type: "Airline advisory page",
        url: ADVISORY_SOURCES[i].url,
        checkedAt: new Date().toISOString(),
        status: "unavailable",
        records: null,
        message: "Unexpected error while checking this source",
      });
    }
  });
  return { advisories, health };
}
