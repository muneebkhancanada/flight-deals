/**
 * KWI Operations Monitor — frontend.
 * Plain vanilla JS. All rendering goes through esc() so externally supplied
 * text can never inject HTML. No secrets exist anywhere in this file.
 */
(function () {
  "use strict";

  var POLL_MS = 60000;
  var state = {
    snapshot: null,
    tab: "arrivals",
    search: "",
    priorityOnly: false,
    stateFilter: "",
    sortOrder: "asc",
  };

  var OFFICIAL_LINKS = [
    { label: "Kuwait International Airport — flight status", url: "https://www.kuwaitairport.gov.kw/en/flights-info/flight-status/arrivals/" },
    { label: "Kuwait DGCA", url: "https://www.dgca.gov.kw" },
    { label: "@Kuwait_DGCA on X", url: "https://x.com/Kuwait_DGCA" },
    { label: "@KuwaitAirways on X", url: "https://x.com/KuwaitAirways" },
    { label: "@JazeeraAirways on X", url: "https://x.com/JazeeraAirways" },
    { label: "@kuna_en on X", url: "https://x.com/kuna_en" },
    { label: "@Moi_kuw on X", url: "https://x.com/Moi_kuw" },
    { label: "@CGCKuwait on X", url: "https://x.com/CGCKuwait" },
    { label: "@MOFAKuwait on X", url: "https://x.com/MOFAKuwait" },
    { label: "@EGYPTAIR on X", url: "https://x.com/EGYPTAIR" },
    { label: "@emirates on X", url: "https://x.com/emirates" },
    { label: "@flydubai on X", url: "https://x.com/flydubai" },
  ];

  var ADVISORY_PAGES = [
    { label: "Kuwait Airways travel alerts", url: "https://www.kuwaitairways.com/en/pages/travel-alerts" },
    { label: "Jazeera Airways travel updates", url: "https://www.jazeeraairways.com/en-kw/travel-updates" },
    { label: "EgyptAir news", url: "https://www.egyptair.com/en/about-egyptair/news-and-press/Pages/default.aspx" },
    { label: "Emirates travel updates", url: "https://www.emirates.com/us/english/help/travel-updates/" },
    { label: "flydubai travel updates", url: "https://www.flydubai.com/en/plan/travel-updates" },
  ];

  // ---------- utilities ----------

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Only ever link to http(s) URLs. */
  function safeUrl(url) {
    if (typeof url !== "string") return null;
    if (/^https?:\/\//i.test(url)) return esc(url);
    return null;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function fmtTime(iso) {
    if (!iso) return "–";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "–";
    return d.toLocaleString("en-GB", {
      timeZone: "Asia/Kuwait",
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  // ---------- data loading ----------

  function load() {
    fetch("/api/status", { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (snapshot) {
        state.snapshot = snapshot;
        renderAll();
      })
      .catch(function () {
        var el = $("last-refresh");
        if (!state.snapshot) {
          el.textContent = "Could not reach the monitor API — retrying…";
        }
      });
  }

  // ---------- rendering ----------

  function renderAll() {
    var s = state.snapshot;
    if (!s) return;
    renderMeta(s);
    renderAirspace(s.airspace || {});
    renderSummary(s.summary || {});
    updateSocialTabVisibility(s);
    renderActivePanel();
    renderStaticLinks();
  }

  function renderMeta(s) {
    var meta = s.meta || {};
    var when = meta.generatedAt ? fmtTime(meta.generatedAt) : "unknown";
    $("last-refresh").textContent = "Last refresh: " + when + " (Kuwait time)";
    var win = meta.window || { historyHours: 12, futureHours: 96 };
    $("coverage").textContent =
      "Coverage: last " + win.historyHours + " hours plus the next " + win.futureHours + " hours";
    var modeEl = $("data-mode");
    modeEl.className = "meta-item";
    if (meta.dataMode === "cached-degraded") {
      modeEl.textContent = "Live flight feed degraded — showing last good data";
      modeEl.className += " mode-warn";
    } else if (meta.dataMode === "unavailable") {
      modeEl.textContent = "Live flight feed unavailable";
      modeEl.className += " mode-warn";
    } else if (meta.dataMode === "initialising") {
      modeEl.textContent = "Collecting first snapshot…";
    } else {
      modeEl.textContent = "Live official data";
      modeEl.className += " mode-ok";
    }
  }

  function renderAirspace(a) {
    var banner = $("airspace-banner");
    var cls = "airspace-unknown";
    var label = "Unknown";
    if (a.status === "open") {
      cls = a.confidence === "high" ? "airspace-open" : "airspace-open-muted";
      label = "Open";
    } else if (a.status === "closed") {
      cls = "airspace-closed";
      label = "Closed";
    } else if (a.status === "restricted") {
      cls = "airspace-restricted";
      label = "Restricted";
    }
    banner.className = "airspace-banner " + cls;
    $("airspace-status").textContent = "Kuwait airspace: " + label;
    $("airspace-confidence").textContent = a.confidence ? "Confidence: " + a.confidence : "";
    $("airspace-reason").textContent = a.reason || "";
    var src = $("airspace-source");
    var updated = a.updatedAt ? " · Updated " + fmtTime(a.updatedAt) : "";
    var link = safeUrl(a.sourceUrl);
    src.innerHTML =
      "Source: " + esc(a.source || "n/a") + esc(updated) +
      (link ? ' · <a href="' + link + '" rel="noopener">details</a>' : "");
  }

  function renderSummary(sum) {
    $("sum-arrivals").textContent = num(sum.arrivals);
    $("sum-departures").textContent = num(sum.departures);
    $("sum-delayed").textContent = num(sum.delayed);
    $("sum-delayed2h").textContent = num(sum.delayedTwoHours);
    $("sum-cancelled").textContent = num(sum.cancelled);
    $("sum-diverted").textContent = num(sum.diverted);
    function num(v) {
      return v == null ? "–" : String(v);
    }
  }

  /** Official Posts tab exists only when the snapshot actually has posts. */
  function updateSocialTabVisibility(s) {
    var hasPosts = Array.isArray(s.social) && s.social.length > 0;
    var tab = $("tab-social");
    tab.classList.toggle("hidden", !hasPosts);
    if (!hasPosts && state.tab === "social") {
      switchTab("arrivals");
    }
  }

  function renderActivePanel() {
    var isFlights = state.tab === "arrivals" || state.tab === "departures";
    $("flight-controls").classList.toggle("hidden", !isFlights);
    $("panel-flights").classList.toggle("hidden", !isFlights);
    $("panel-notams").classList.toggle("hidden", state.tab !== "notams");
    $("panel-advisories").classList.toggle("hidden", state.tab !== "advisories");
    $("panel-health").classList.toggle("hidden", state.tab !== "health");
    $("panel-social").classList.toggle("hidden", state.tab !== "social");
    if (isFlights) renderFlights();
    if (state.tab === "notams") renderNotams();
    if (state.tab === "advisories") renderAdvisories();
    if (state.tab === "health") renderHealth();
    if (state.tab === "social") renderSocial();
  }

  // ---------- flights ----------

  function flightMatchesFilters(f) {
    if (f.direction !== (state.tab === "arrivals" ? "arrival" : "departure")) return false;
    if (state.priorityOnly && !f.priority) return false;
    if (state.stateFilter) {
      var completed = Boolean(f.actualUtc) || f.status === "Departed" || f.status === "Arrived";
      switch (state.stateFilter) {
        case "delayed":
          if (!(f.status === "Delayed" || (f.delayMinutes != null && f.delayMinutes >= 10))) return false;
          if (f.cancelled || f.diverted) return false;
          break;
        case "cancelled":
          if (!f.cancelled) return false;
          break;
        case "diverted":
          if (!f.diverted) return false;
          break;
        case "completed":
          if (!completed) return false;
          break;
        case "scheduled":
          if (completed || f.cancelled || f.diverted) return false;
          break;
      }
    }
    if (state.search) {
      var q = state.search.toLowerCase();
      var hay = [f.flightNumber, f.rawIdentifier, f.airline, f.origin, f.destination, f.routeLabel]
        .join(" ")
        .toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function sortedFilteredFlights() {
    var flights = (state.snapshot.flights || []).filter(flightMatchesFilters);
    flights.sort(function (a, b) {
      var cmp = String(a.scheduledUtc || "").localeCompare(String(b.scheduledUtc || ""));
      return state.sortOrder === "asc" ? cmp : -cmp;
    });
    return flights;
  }

  function toneClass(tone) {
    if (tone === "green") return "tone-green";
    if (tone === "amber") return "tone-amber";
    if (tone === "red") return "tone-red";
    return "tone-neutral";
  }

  function statusCellHtml(f) {
    var d = f.display || {};
    return (
      '<span class="status-pill ' + toneClass(d.tone) + '">' + esc(d.primary || f.status || "Unknown") + "</span>" +
      (d.secondary ? '<span class="status-secondary">' + esc(d.secondary) + "</span>" : "")
    );
  }

  function timeCellHtml(f) {
    var d = f.display || {};
    return (
      '<span class="op-time">' + esc(d.displayTimeLocal || f.scheduledLocal || "–") + "</span>" +
      '<span class="op-time-label">' + esc(d.timeLabel || "Scheduled") + "</span>" +
      (f.scheduledLocalDate ? '<span class="op-time-date">' + esc(f.scheduledLocalDate) + "</span>" : "")
    );
  }

  function renderFlights() {
    var flights = sortedFilteredFlights();
    var tbody = $("flight-tbody");
    var cards = $("flight-cards");
    var empty = $("flight-empty");

    tbody.innerHTML = flights
      .map(function (f) {
        var link = safeUrl(f.sourceUrl);
        return (
          '<tr class="' + (f.priority ? "row-priority" : "") + '">' +
          "<td>" + timeCellHtml(f) + "</td>" +
          '<td class="cell-flight">' + (f.priority ? '<span class="star" title="Priority airline">★</span>' : "") +
            esc(f.flightNumber) +
            (f.rawIdentifier && f.rawIdentifier !== f.flightNumber
              ? '<span class="raw-id">' + esc(f.rawIdentifier) + "</span>"
              : "") + "</td>" +
          "<td>" + esc(f.airline) + "</td>" +
          "<td>" + esc(f.routeLabel || (f.origin + " → " + f.destination)) + "</td>" +
          "<td>" + esc(joinTerminalGate(f)) + "</td>" +
          "<td>" + statusCellHtml(f) + "</td>" +
          "<td>" + (link ? '<a href="' + link + '" rel="noopener">' + esc(f.source) + "</a>" : esc(f.source)) + "</td>" +
          "</tr>"
        );
      })
      .join("");

    cards.innerHTML = flights
      .map(function (f) {
        var d = f.display || {};
        return (
          '<article class="flight-card ' + toneClass(d.tone) + '-border">' +
          '<div class="card-top"><span class="card-flight">' +
          (f.priority ? '<span class="star">★</span>' : "") + esc(f.flightNumber) +
          "</span>" + statusCellHtml(f) + "</div>" +
          '<div class="card-route">' + esc(f.routeLabel || "") + "</div>" +
          '<div class="card-line">' + esc(d.timeLabel || "Scheduled") + ": " +
          esc(d.displayTimeLocal || f.scheduledLocal || "–") +
          (f.scheduledLocalDate ? " (" + esc(f.scheduledLocalDate) + ")" : "") + "</div>" +
          '<div class="card-line">' + esc(f.airline) + " · " + esc(joinTerminalGate(f)) + "</div>" +
          "</article>"
        );
      })
      .join("");

    var feedDown =
      state.snapshot.meta &&
      (state.snapshot.meta.dataMode === "unavailable" || state.snapshot.meta.dataMode === "initialising");
    if (flights.length === 0) {
      empty.classList.remove("hidden");
      if (feedDown) {
        empty.textContent =
          state.snapshot.meta.dataMode === "initialising"
            ? "The monitor is collecting its first snapshot — data will appear shortly."
            : "The live flight feed is currently unavailable or degraded. This does not mean no flights are operating.";
      } else {
        empty.textContent = "No flights match the current filters in this window.";
      }
    } else {
      empty.classList.add("hidden");
    }
  }

  function joinTerminalGate(f) {
    var parts = [];
    if (f.terminal) parts.push(f.terminal);
    if (f.gate) parts.push("Gate " + f.gate);
    return parts.length ? parts.join(" · ") : "–";
  }

  // ---------- NOTAMs ----------

  function renderNotams() {
    var notices = state.snapshot.notices || [];
    var list = $("notam-list");
    var empty = $("notam-empty");
    list.innerHTML = notices
      .map(function (n, i) {
        var sevClass = n.severity === "critical" ? "tone-red" : n.severity === "major" ? "tone-amber" : "tone-neutral";
        var link = safeUrl(n.url);
        return (
          '<article class="notice-card">' +
          '<div class="notice-head"><span class="status-pill ' + sevClass + '">' + esc(n.severity) + "</span>" +
          '<span class="notice-category">' + esc(n.category) + "</span>" +
          '<span class="notice-ref">' + esc(n.reference) + " · " + esc(n.location || "") + "</span></div>" +
          (n.meaning ? "<p><strong>What this means:</strong> " + esc(n.meaning) + "</p>" : "") +
          (n.impact ? "<p><strong>Possible passenger impact:</strong> " + esc(n.impact) + "</p>" : "") +
          (n.advice ? "<p><strong>What travellers should do:</strong> " + esc(n.advice) + "</p>" : "") +
          '<p class="notice-dates">Effective: ' + esc(n.effectiveFrom || "n/a") + " → " + esc(n.effectiveTo || "n/a") + "</p>" +
          (link ? '<p><a href="' + link + '" rel="noopener">Official notice source</a></p>' : "") +
          '<details><summary>Technical NOTAM text</summary><pre class="notam-text">' + esc(n.text || "") + "</pre></details>" +
          "</article>"
        );
      })
      .join("");
    if (notices.length === 0) {
      empty.classList.remove("hidden");
      var notamHealth = findHealth("dgca-notams");
      empty.textContent =
        notamHealth && notamHealth.status !== "ok"
          ? "The NOTAM feed is currently unavailable — major notices cannot be checked right now."
          : "No high-impact NOTAMs are currently in effect for Kuwait. Routine technical notices are intentionally hidden.";
    } else {
      empty.classList.add("hidden");
    }
  }

  // ---------- advisories ----------

  function renderAdvisories() {
    var advisories = state.snapshot.advisories || [];
    var list = $("advisory-list");
    var empty = $("advisory-empty");
    list.innerHTML = advisories
      .map(function (a) {
        var link = safeUrl(a.url);
        return (
          '<article class="notice-card">' +
          '<div class="notice-head"><span class="status-pill tone-amber">advisory</span>' +
          '<span class="notice-category">' + esc(a.airline) + "</span></div>" +
          "<p>" + esc(a.excerpt || "") + "</p>" +
          '<p class="notice-dates">Detected: ' + esc(fmtTime(a.detectedAt)) + "</p>" +
          (link ? '<p><a href="' + link + '" rel="noopener">Open advisory page</a></p>' : "") +
          "</article>"
        );
      })
      .join("");
    empty.classList.toggle("hidden", advisories.length !== 0);
    if (advisories.length === 0) {
      empty.textContent =
        "No Kuwait-specific airline advisories were detected on the monitored pages. Check the official pages below for full details.";
    }
    $("advisory-links").innerHTML = ADVISORY_PAGES.map(function (p) {
      return '<li><a href="' + safeUrl(p.url) + '" rel="noopener">' + esc(p.label) + "</a></li>";
    }).join("");
  }

  // ---------- source health ----------

  function findHealth(id) {
    var all = state.snapshot.sourceHealth || [];
    for (var i = 0; i < all.length; i += 1) {
      if (all[i] && all[i].id === id) return all[i];
    }
    return null;
  }

  function renderHealth() {
    var items = state.snapshot.sourceHealth || [];
    $("health-list").innerHTML = items
      .filter(Boolean)
      .map(function (h) {
        var cls =
          h.status === "ok" ? "tone-green" : h.status === "degraded" ? "tone-amber" :
          h.status === "not-configured" ? "tone-neutral" : "tone-red";
        var link = safeUrl(h.url);
        return (
          '<article class="health-card">' +
          '<div class="notice-head"><span class="status-pill ' + cls + '">' + esc(h.status) + "</span>" +
          '<span class="notice-category">' + esc(h.name) + "</span>" +
          '<span class="notice-ref">' + esc(h.type || "") + "</span></div>" +
          '<p class="notice-dates">Checked: ' + esc(fmtTime(h.checkedAt)) +
          (h.records != null ? " · Records: " + esc(h.records) : "") + "</p>" +
          (h.message ? "<p>" + esc(h.message) + "</p>" : "") +
          (link ? '<p><a href="' + link + '" rel="noopener">Source</a></p>' : "") +
          "</article>"
        );
      })
      .join("");
  }

  // ---------- official posts ----------

  function renderSocial() {
    var posts = state.snapshot.social || [];
    $("social-list").innerHTML = posts
      .map(function (p) {
        var link = safeUrl(p.url);
        return (
          '<article class="notice-card">' +
          '<div class="notice-head"><span class="notice-category">' + esc(p.author) + "</span>" +
          (p.username ? '<span class="notice-ref">@' + esc(p.username) + "</span>" : "") +
          '<span class="notice-ref">' + esc(fmtTime(p.time)) + "</span></div>" +
          "<p>" + esc(p.text) + "</p>" +
          (p.whyItMatters ? "<p><strong>Why it matters:</strong> " + esc(p.whyItMatters) + "</p>" : "") +
          (p.verification ? '<p class="verification">' + esc(p.verification) + "</p>" : "") +
          (link ? '<p><a href="' + link + '" rel="noopener">View post</a></p>' : "") +
          "</article>"
        );
      })
      .join("");
  }

  function renderStaticLinks() {
    $("official-links").innerHTML = OFFICIAL_LINKS.map(function (l) {
      return '<li><a href="' + safeUrl(l.url) + '" rel="noopener">' + esc(l.label) + "</a></li>";
    }).join("");
  }

  // ---------- events ----------

  function switchTab(tab) {
    state.tab = tab;
    var buttons = document.querySelectorAll(".tab");
    for (var i = 0; i < buttons.length; i += 1) {
      var active = buttons[i].getAttribute("data-tab") === tab;
      buttons[i].classList.toggle("active", active);
      buttons[i].setAttribute("aria-selected", active ? "true" : "false");
    }
    renderActivePanel();
  }

  $("tabs").addEventListener("click", function (event) {
    var tab = event.target.getAttribute && event.target.getAttribute("data-tab");
    if (tab) switchTab(tab);
  });
  $("search").addEventListener("input", function (event) {
    state.search = event.target.value.trim();
    renderFlights();
  });
  $("filter-priority").addEventListener("change", function (event) {
    state.priorityOnly = event.target.checked;
    renderFlights();
  });
  $("filter-state").addEventListener("change", function (event) {
    state.stateFilter = event.target.value;
    renderFlights();
  });
  $("sort-order").addEventListener("change", function (event) {
    state.sortOrder = event.target.value;
    renderFlights();
  });

  load();
  setInterval(load, POLL_MS);
})();
