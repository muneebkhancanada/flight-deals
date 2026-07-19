/**
 * Optional ingestion of official X (Twitter) posts.
 *
 * Runs ONLY when the X_BEARER_TOKEN secret is configured. All monitored
 * accounts are covered by a single recent-search request (one API call per
 * refresh) with retweets excluded. Posts are supporting evidence: each one is
 * cross-checked against current flight/NOTAM data and labelled accordingly —
 * never treated as authoritative on their own.
 *
 * When the token is absent or no posts exist, the module reports
 * `configured:false` / zero posts and the snapshot builder omits both the
 * Official Posts tab data and the X source-health card entirely, so ordinary
 * dashboard users never see setup noise.
 */

import { X_ACCOUNTS } from "../config.js";
import { fetchWithTimeout, sanitizeText, safeHttpUrl } from "../util.js";

const SEARCH_URL = "https://api.twitter.com/2/tweets/search/recent";

/** Keyword → traveller-facing relevance explanation (rule-based, no LLM). */
const RELEVANCE_RULES = [
  { pattern: /airspace|فضاء/i, note: "Mentions airspace status, which can affect all KWI flights." },
  { pattern: /suspend|توقف|تعليق/i, note: "Mentions a suspension that may affect KWI services." },
  { pattern: /cancel/i, note: "Mentions cancellations that may affect KWI passengers." },
  { pattern: /divert/i, note: "Mentions diversions affecting flight operations." },
  { pattern: /delay/i, note: "Mentions delays that may affect KWI schedules." },
  { pattern: /resum/i, note: "Mentions resumption of services relevant to KWI travellers." },
  { pattern: /notam|closure|closed/i, note: "Mentions a closure or official notice affecting operations." },
  { pattern: /\b[A-Z]{2}\s?\d{2,4}\b/, note: "References a specific flight number." },
];

/** Explain why a post matters to KWI travellers (or a neutral default). */
export function explainRelevance(text) {
  for (const rule of RELEVANCE_RULES) {
    if (rule.pattern.test(text || "")) return rule.note;
  }
  return "Official account activity; monitor for operational updates.";
}

/**
 * Cross-check a post against official data. Returns a verification label:
 * posts naming a flight found disrupted in official KWI data, or echoing an
 * active major NOTAM category, are marked corroborated.
 */
export function verifyPost(text, flights = [], notices = []) {
  const t = (text || "").toUpperCase();
  const flightMatch = flights.find(
    (f) =>
      (f.cancelled || f.diverted || (f.delayMinutes ?? 0) >= 60) &&
      f.flightNumber &&
      t.includes(f.flightNumber.toUpperCase()),
  );
  if (flightMatch) {
    return `Corroborated: official airport data shows ${flightMatch.flightNumber} is ${flightMatch.status.toLowerCase()}.`;
  }
  if (/AIRSPACE|CLOSED|CLOSURE|SUSPEND/.test(t)) {
    const notamMatch = notices.find((n) => n.severity === "critical");
    if (notamMatch) {
      return `Corroborated: an active NOTAM (${notamMatch.reference}) reports ${notamMatch.category.toLowerCase()}.`;
    }
    return "Not yet verified against an official airport, DGCA or NOTAM source — treat as unconfirmed.";
  }
  return "Informational; verify time-critical claims with your airline.";
}

/** Build the single search query covering every monitored account. */
export function buildSearchQuery(accounts = X_ACCOUNTS) {
  const from = accounts.map((a) => `from:${a.username}`).join(" OR ");
  return `(${from}) -is:retweet`;
}

/**
 * Fetch recent posts. Returns { configured:false } when no token is set —
 * the caller then omits the social section and its health card entirely.
 */
export async function collectSocialPosts(env, { flights = [], notices = [] } = {}) {
  if (!env.X_BEARER_TOKEN) {
    return { configured: false, ok: false, posts: [], health: null };
  }
  const checkedAt = new Date().toISOString();
  const health = {
    id: "x-official-posts",
    name: "Official X accounts",
    type: "Social feed (supporting evidence)",
    url: "https://x.com/Kuwait_DGCA",
    checkedAt,
    status: "unavailable",
    records: null,
    message: null,
  };
  try {
    const params = new URLSearchParams({
      query: buildSearchQuery(),
      max_results: "50",
      "tweet.fields": "created_at,author_id,attachments,entities",
      expansions: "author_id,attachments.media_keys",
      "user.fields": "name,username",
      "media.fields": "type,url,preview_image_url",
    });
    const response = await fetchWithTimeout(`${SEARCH_URL}?${params}`, {
      headers: { authorization: `Bearer ${env.X_BEARER_TOKEN}` },
    });
    if (!response.ok) {
      health.status = response.status === 429 ? "degraded" : "unavailable";
      health.message = `X API responded HTTP ${response.status}`;
      return { configured: true, ok: false, posts: [], health };
    }
    const payload = await response.json();
    const users = new Map((payload.includes?.users || []).map((u) => [u.id, u]));
    const media = new Map((payload.includes?.media || []).map((m) => [m.media_key, m]));
    const posts = (payload.data || []).map((tweet) => {
      const user = users.get(tweet.author_id) || {};
      const text = sanitizeText(tweet.text, 800) || "";
      const mediaKeys = tweet.attachments?.media_keys || [];
      return {
        id: sanitizeText(tweet.id, 32),
        author: sanitizeText(user.name, 80) || "Official account",
        username: sanitizeText(user.username, 32) || null,
        time: tweet.created_at || null,
        text,
        url:
          user.username && tweet.id
            ? safeHttpUrl(`https://x.com/${user.username}/status/${tweet.id}`)
            : null,
        media: mediaKeys
          .map((k) => media.get(k))
          .filter(Boolean)
          .map((m) => ({ type: m.type, url: safeHttpUrl(m.url || m.preview_image_url) })),
        summary: sanitizeText(text, 180),
        whyItMatters: explainRelevance(text),
        verification: verifyPost(text, flights, notices),
      };
    });
    health.status = "ok";
    health.records = posts.length;
    health.message = posts.length === 0 ? "X API reachable; no recent posts from monitored accounts" : null;
    return { configured: true, ok: true, posts, health };
  } catch (error) {
    health.message =
      error?.name === "AbortError"
        ? "X API timed out"
        : `X API request failed: ${sanitizeText(error?.message, 160) || "unknown error"}`;
    return { configured: true, ok: false, posts: [], health };
  }
}
