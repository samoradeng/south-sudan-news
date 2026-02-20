// Weekly Risk Delta generator
// Computes week-over-week changes and produces a structured intelligence digest.
// Output: structured data object + pre-rendered HTML for email/dashboard preview.

const {
  getEventsForPeriod,
  getTypeCountsForPeriod,
  getRegionSeverityForPeriod,
  getActorCountsForPeriod,
} = require('./db');

const { normalizeActor } = require('./extractor');

// ─── Helpers ────────────────────────────────────────────────────

const MIN_BASELINE_EVENTS = 5; // Suppress % deltas below this threshold

function getWeekBounds(weeksAgo = 0) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() - (weeksAgo * 7));
  end.setHours(23, 59, 59, 999);

  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);

  return {
    start: start.toISOString().slice(0, 19).replace('T', ' '),
    end: end.toISOString().slice(0, 19).replace('T', ' '),
    label: `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`,
  };
}

function pctChange(current, previous) {
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return 100;
  return Math.round(((current - previous) / previous) * 100);
}

function formatChange(pct, baselineWeak) {
  if (baselineWeak) return 'new';
  if (pct > 0) return `+${pct}%`;
  if (pct < 0) return `${pct}%`;
  return 'unchanged';
}

function getISOWeekNumber(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

function safeJSON(s) {
  if (Array.isArray(s)) return s;
  try { return JSON.parse(s || '[]'); } catch { return []; }
}

// ─── Rationale cleanup ──────────────────────────────────────────
// Old DB entries (prompt v2) have verbose AI-justification prose like
// "The severity is rated as critical due to..."
// These add no signal — the summary already states the fact.
// Suppress old-style rationale entirely; only show v3+ one-liners.

function cleanRationale(rationale) {
  if (!rationale) return null;
  const trimmed = rationale.trim();
  // Old-style: starts with scoring methodology language — suppress
  if (/^the (severity|verification|confidence)/i.test(trimmed)) return null;
  // Old-style: starts with "This is rated..." or "Rated as..."
  if (/^(this is rated|rated as|severity \d)/i.test(trimmed)) return null;
  // Old-style: contains "which is a" value judgment filler
  if (/which is a (grave|significant|major|serious)/i.test(trimmed)) return null;
  // Passes filters — it's a clean v3+ rationale or genuinely useful
  return trimmed;
}

// ─── Region containment for dedup ───────────────────────────────
// "El Fasher" is inside "North Darfur" is inside "Darfur"
// This handles the case where the same story gets tagged to different
// geographic levels of the same area.

const REGION_CONTAINMENT = {
  'el fasher': ['north darfur', 'darfur'],
  'al-fashir': ['north darfur', 'darfur'],
  'al fashir': ['north darfur', 'darfur'],
  'nyala': ['south darfur', 'darfur'],
  'el geneina': ['west darfur', 'darfur'],
  'zalingei': ['central darfur', 'darfur'],
  'north darfur': ['darfur'],
  'south darfur': ['darfur'],
  'west darfur': ['darfur'],
  'central darfur': ['darfur'],
  'east darfur': ['darfur'],
  'juba': ['central equatoria'],
  'malakal': ['upper nile'],
  'bor': ['jonglei'],
  'bentiu': ['unity'],
  'wau': ['western bahr el ghazal'],
};

function regionsOverlap(regionsA, regionsB) {
  if (regionsA.length === 0 || regionsB.length === 0) return true;

  const normA = regionsA.map(r => r.toLowerCase().trim());
  const normB = regionsB.map(r => r.toLowerCase().trim());

  for (const a of normA) {
    for (const b of normB) {
      // Direct match
      if (a === b) return true;
      // A is contained in B's area
      if ((REGION_CONTAINMENT[a] || []).includes(b)) return true;
      // B is contained in A's area
      if ((REGION_CONTAINMENT[b] || []).includes(a)) return true;
      // Both contained in a common parent
      const parentsA = REGION_CONTAINMENT[a] || [];
      const parentsB = REGION_CONTAINMENT[b] || [];
      if (parentsA.some(p => parentsB.includes(p))) return true;
    }
  }
  return false;
}

// ─── Region display: collapse flat list into hierarchy ──────────
// ["El Fasher", "North Darfur", "Darfur"] → "North Darfur (El Fasher)"
// Removes redundant parent regions when children are present.

function collapseRegions(regions) {
  if (regions.length <= 1) return regions;

  const normed = regions.map(r => ({ orig: r, key: r.toLowerCase().trim() }));

  // Mark regions that are a parent of another region in the list
  const parentKeys = new Set();
  // Mark regions that are a child (have a parent in the list)
  const childKeys = new Set();

  for (const r of normed) {
    const parents = REGION_CONTAINMENT[r.key] || [];
    for (const p of parents) {
      if (normed.some(n => n.key === p)) {
        parentKeys.add(p);
        childKeys.add(r.key);
      }
    }
  }

  // Build display: for each "mid-level" region (state level, not a pure child),
  // append its children in parentheses. Skip top-level parents that are redundant.
  const result = [];
  const used = new Set();

  for (const r of normed) {
    if (used.has(r.key)) continue;

    // Skip if this region is purely a parent of something already shown
    if (parentKeys.has(r.key) && !childKeys.has(r.key)) {
      // It's a top-level parent — skip if a child exists
      // E.g., "Darfur" when "North Darfur" is present
      used.add(r.key);
      continue;
    }

    // Find children of this region in the list
    const children = normed.filter(n =>
      n.key !== r.key &&
      !used.has(n.key) &&
      (REGION_CONTAINMENT[n.key] || []).includes(r.key)
    );

    if (children.length > 0) {
      const childNames = children.map(c => c.orig);
      result.push(`${r.orig} (${childNames.join(', ')})`);
      used.add(r.key);
      children.forEach(c => used.add(c.key));
    } else {
      result.push(r.orig);
      used.add(r.key);
    }
  }

  return result;
}

// ─── Event deduplication for digest ─────────────────────────────
// Groups high-severity events describing the same story into bundles.
// Matches on country + subtype + severity, with fuzzy region containment.
// Allows type mismatch (security/genocide vs humanitarian/genocide = same story).

function bundleHighSeverityEvents(events) {
  const bundles = [];

  for (const event of events) {
    const evRegions = safeJSON(event.regions);
    const evSubtype = (event.event_subtype || '').toLowerCase();
    const evCountry = (event.country || '').toLowerCase();

    // Try to merge into existing bundle
    let merged = false;
    for (const bundle of bundles) {
      const bSubtype = (bundle.eventSubtype || '').toLowerCase();
      const bCountry = (bundle.country || '').toLowerCase();

      // Same country + same subtype + same severity + overlapping regions
      const sameStory = bCountry === evCountry
        && bSubtype === evSubtype
        && bundle.severity === event.severity
        && regionsOverlap(bundle.regions, evRegions);

      if (sameStory) {
        bundle.sourceCount += event.article_count || 1;
        bundle.sources.push(...safeJSON(event.sources));
        bundle.articleUrls.push(...safeJSON(event.article_urls));
        // Merge new regions
        for (const r of evRegions) {
          if (!bundle.regions.some(br => br.toLowerCase() === r.toLowerCase())) {
            bundle.regions.push(r);
          }
        }
        // Merge actors
        const evActors = safeJSON(event.actors_normalized || event.actors);
        for (const a of evActors) {
          if (!bundle.actors.some(ba => ba.toLowerCase() === a.toLowerCase())) {
            bundle.actors.push(a);
          }
        }
        if (!bundle.primaryUrl && event.primary_url) {
          bundle.primaryUrl = event.primary_url;
        }
        merged = true;
        break;
      }
    }

    if (!merged) {
      bundles.push({
        summary: event.summary,
        severity: event.severity,
        eventType: event.event_type,
        eventSubtype: event.event_subtype,
        country: event.country,
        regions: [...evRegions],
        actors: [...safeJSON(event.actors_normalized || event.actors)],
        rationale: cleanRationale(event.rationale),
        verificationStatus: event.verification_status,
        confidence: event.confidence,
        primaryUrl: event.primary_url,
        publishedAt: event.published_at,
        sourceCount: event.article_count || 1,
        sources: [...new Set(safeJSON(event.sources))],
        articleUrls: [...safeJSON(event.article_urls)],
      });
    }
  }

  // Deduplicate source names in each bundle
  for (const b of bundles) {
    b.sources = [...new Set(b.sources)];
    b.articleUrls = [...new Set(b.articleUrls)];
  }

  return bundles;
}

// ─── Re-normalize actor counts at digest time ───────────────────
// Old DB entries may have un-merged actors (UN vs United Nations, etc.)
// Re-apply the canonical alias table and merge counts.

function renormalizeActorList(actorList) {
  const merged = {};
  for (const { actor, count } of actorList) {
    const canonical = normalizeActor(actor);
    merged[canonical] = (merged[canonical] || 0) + count;
  }
  return Object.entries(merged)
    .sort((a, b) => b[1] - a[1])
    .map(([actor, count]) => ({ actor, count }));
}

// ─── Main digest generator ──────────────────────────────────────

function generateDigest() {
  const thisWeek = getWeekBounds(0);
  const lastWeek = getWeekBounds(1);

  // Events
  const twEvents = getEventsForPeriod(thisWeek.start, thisWeek.end);
  const lwEvents = getEventsForPeriod(lastWeek.start, lastWeek.end);

  // Determine if baseline is too weak for meaningful % comparison
  const baselineWeak = lwEvents.length < MIN_BASELINE_EVENTS;

  // Type counts
  const twTypes = getTypeCountsForPeriod(thisWeek.start, thisWeek.end);
  const lwTypes = getTypeCountsForPeriod(lastWeek.start, lastWeek.end);

  // Region severity
  const twRegions = getRegionSeverityForPeriod(thisWeek.start, thisWeek.end);
  const lwRegions = getRegionSeverityForPeriod(lastWeek.start, lastWeek.end);

  // Actor counts (re-normalized at digest time)
  const twActors = renormalizeActorList(getActorCountsForPeriod(thisWeek.start, thisWeek.end));
  const lwActors = renormalizeActorList(getActorCountsForPeriod(lastWeek.start, lastWeek.end));

  // ── Section 1: Topline Shift ──────────────────────────────
  const lwTypeMap = Object.fromEntries(lwTypes.map((t) => [t.event_type, t]));
  const typeShifts = twTypes.map((t) => {
    const prev = lwTypeMap[t.event_type];
    return {
      type: t.event_type,
      thisWeek: t.count,
      lastWeek: prev ? prev.count : 0,
      change: pctChange(t.count, prev ? prev.count : 0),
      avgSeverity: t.avg_severity,
    };
  });

  // Include types from last week not present this week (they dropped to 0)
  for (const lt of lwTypes) {
    if (!twTypes.find((t) => t.event_type === lt.event_type)) {
      typeShifts.push({
        type: lt.event_type,
        thisWeek: 0,
        lastWeek: lt.count,
        change: -100,
        avgSeverity: 0,
      });
    }
  }

  const topline = {
    totalThisWeek: twEvents.length,
    totalLastWeek: lwEvents.length,
    totalChange: pctChange(twEvents.length, lwEvents.length),
    baselineWeak,
    typeShifts,
  };

  // ── Section 2: High-Severity Events (bundled) ──────────────
  const rawHighSev = twEvents.filter((e) => e.severity >= 4);
  const highSeverity = bundleHighSeverityEvents(rawHighSev).slice(0, 8);

  // ── Section 3: Hot Regions ────────────────────────────────
  const lwRegionMap = Object.fromEntries(lwRegions.map((r) => [r.region, r]));
  const hotRegions = twRegions.slice(0, 10).map((r) => {
    const prev = lwRegionMap[r.region];
    return {
      region: r.region,
      count: r.count,
      severityWeighted: r.severityWeighted,
      avgSeverity: r.avgSeverity,
      prevCount: prev ? prev.count : 0,
      change: pctChange(r.count, prev ? prev.count : 0),
    };
  });

  // ── Section 4: Actor Spikes ───────────────────────────────
  const lwActorMap = Object.fromEntries(lwActors.map((a) => [a.actor, a.count]));
  const actorSpikes = twActors.slice(0, 15).map((a) => {
    const prev = lwActorMap[a.actor] || 0;
    return {
      actor: a.actor,
      thisWeek: a.count,
      lastWeek: prev,
      change: pctChange(a.count, prev),
    };
  }).sort((a, b) => b.change - a.change);

  const weekNum = getISOWeekNumber(new Date());

  return {
    weekNumber: weekNum,
    generatedAt: new Date().toISOString(),
    period: { thisWeek: thisWeek.label, lastWeek: lastWeek.label },
    topline,
    highSeverity,
    hotRegions,
    actorSpikes,
    dataPoints: {
      eventsThisWeek: twEvents.length,
      eventsLastWeek: lwEvents.length,
      highSevCount: highSeverity.length,
      highSevRawCount: rawHighSev.length,
      countriesThisWeek: [...new Set(twEvents.map((e) => e.country))],
      baselineWeak,
    },
  };
}

// ─── Render to HTML (for email / dashboard preview) ─────────

const SEV_LABELS = { 1: 'Routine', 2: 'Notable', 3: 'Significant', 4: 'Major', 5: 'Critical' };

// Muted institutional color ladder — no bright reds, no alarm theater
const SEV_COLORS = {
  5: { badge: '#7A1F1F', badgeText: '#D4A0A0', border: '#2A1818' },  // deep burgundy — border barely visible
  4: { badge: '#5C3A10', badgeText: '#D4B07A', border: '#28200E' },  // burnt amber — badge carries it
  3: { badge: '#2A3A4A', badgeText: '#8AAAC0', border: '#1E2A38' },  // slate blue-gray
  2: { badge: '#2A2A2E', badgeText: '#8A8A90', border: '#1E1E22' },  // neutral gray
  1: { badge: '#222226', badgeText: '#6A6A70', border: '#1A1A1E' },  // light gray
};

function renderDigestHTML(digest) {
  const d = digest;
  const bw = d.topline.baselineWeak;

  let html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0C0C10; color: #C8C8CC; max-width: 660px; margin: 0 auto; padding: 40px 28px; line-height: 1.65; -webkit-font-smoothing: antialiased; }

/* Document header — feels like a memo, not a UI label */
.doc-header { margin-bottom: 36px; padding-bottom: 20px; border-bottom: 1px solid #1C1C24; }
.doc-title { font-size: 18px; font-weight: 600; color: #E8E8EC; letter-spacing: -0.3px; margin: 0 0 6px 0; }
.doc-subtitle { font-size: 12px; color: #5A5A64; letter-spacing: 0.2px; margin: 0; }

/* Section headers — quiet authority */
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 1.6px; color: #6A6A74; font-weight: 600; margin: 36px 0 16px 0; padding-bottom: 8px; border-bottom: 1px solid #18181E; }

/* Baseline notice */
.baseline-note { color: #7A7A60; font-size: 11px; letter-spacing: 0.2px; margin-bottom: 14px; padding: 8px 12px; background: #12120E; border-radius: 4px; }

/* Topline rows */
.topline-row { display: flex; justify-content: space-between; align-items: center; padding: 9px 0; border-bottom: 1px solid #14141A; font-size: 13px; }
.topline-type { color: #A0A0A8; font-weight: 500; }
.topline-nums { color: #6A6A74; font-size: 12px; }
.change-up { color: #C07A5A; font-weight: 600; }
.change-down { color: #5A9A6A; font-weight: 600; }
.change-flat { color: #4A4A54; }
.change-new { color: #9A8A5A; font-weight: 500; }

/* Event cards — no red stripe, composed neutral */
.event-card { background: #111116; border: 1px solid #1C1C24; border-radius: 6px; padding: 20px 22px; margin-bottom: 18px; }

/* Summary headline */
.event-card .ev-summary { font-size: 14px; color: #D8D8DC; font-weight: 500; line-height: 1.5; margin: 0 0 12px 0; }

/* Stacked metadata — breathable hierarchy */
.ev-meta-stack { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 4px; }
.badge { display: inline-block; font-size: 10px; font-weight: 600; padding: 3px 10px; border-radius: 3px; letter-spacing: 0.5px; text-transform: uppercase; }
.ev-location { font-size: 12px; color: #7A7A84; }
.ev-verification { font-size: 11px; color: #5A5A64; }
.ev-source-link { font-size: 11px; }

/* Source count line */
.ev-sources { font-size: 11px; color: #4A4A54; margin-top: 8px; letter-spacing: 0.1px; }

/* Rationale — footnote energy */
.ev-rationale { font-size: 11px; color: #5A5A60; margin-top: 6px; line-height: 1.5; }

/* Hot Regions */
.region-row { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; border-bottom: 1px solid #14141A; font-size: 13px; }

/* Actor Activity */
.actor-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #14141A; font-size: 13px; }
.actor-row.top-actor .actor-name { color: #D0D0D4; font-weight: 500; }
.actor-row .actor-name { color: #9A9AA0; }
.actor-row .actor-count { color: #5A5A64; font-size: 12px; }
.actor-bar { display: inline-block; height: 3px; background: #2A2A34; border-radius: 2px; margin-left: 8px; vertical-align: middle; }

/* Footer */
.footer { margin-top: 44px; padding-top: 16px; border-top: 1px solid #18181E; font-size: 10px; color: #3A3A44; letter-spacing: 0.2px; line-height: 1.6; }
a { color: #6A8AAA; text-decoration: none; }
a:hover { color: #8AAAC0; }
</style></head><body>`;

  // Document header
  html += '<div class="doc-header">';
  html += `<p class="doc-title">Horn Risk Delta — Week ${d.weekNumber}</p>`;
  html += `<p class="doc-subtitle">${d.period.thisWeek} &middot; Generated ${new Date(d.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>`;
  html += '</div>';

  // Section 1: Topline
  html += '<h2>Topline</h2>';
  if (bw) {
    html += '<div class="baseline-note">Baseline week — prior data insufficient for trend comparison. Raw counts shown.</div>';
  }

  if (bw) {
    html += `<div class="topline-row"><span class="topline-type" style="font-weight:600">Total Events</span><span class="topline-nums">${d.topline.totalThisWeek} events tracked</span></div>`;
  } else {
    const totalCls = d.topline.totalChange > 0 ? 'change-up' : d.topline.totalChange < 0 ? 'change-down' : 'change-flat';
    html += `<div class="topline-row"><span class="topline-type" style="font-weight:600">Total Events</span><span class="topline-nums">${d.topline.totalThisWeek} vs ${d.topline.totalLastWeek} <span class="${totalCls}">${formatChange(d.topline.totalChange, bw)}</span></span></div>`;
  }

  for (const t of d.topline.typeShifts) {
    if (bw) {
      html += `<div class="topline-row"><span class="topline-type">${t.type}</span><span class="topline-nums">${t.thisWeek} events (avg sev ${t.avgSeverity})</span></div>`;
    } else {
      const cls = t.change > 0 ? 'change-up' : t.change < 0 ? 'change-down' : 'change-flat';
      html += `<div class="topline-row"><span class="topline-type">${t.type}</span><span class="topline-nums">${t.thisWeek} vs ${t.lastWeek} <span class="${cls}">${formatChange(t.change, bw)}</span></span></div>`;
    }
  }

  // Section 2: High-Severity Events
  html += '<h2>High-Severity Events</h2>';
  if (d.highSeverity.length === 0) {
    html += '<div style="color:#4A4A54; font-size:12px; padding:12px 0">No severity 4-5 events this period.</div>';
  }
  for (const e of d.highSeverity) {
    const sev = SEV_COLORS[e.severity] || SEV_COLORS[3];
    html += `<div class="event-card" style="border-color:${sev.border}">`;
    html += `<div class="ev-summary">${escHTML(e.summary)}</div>`;

    // Stacked meta — severity badge, type badge, location, verification
    html += '<div class="ev-meta-stack">';
    html += `<span class="badge" style="background:${sev.badge};color:${sev.badgeText}">${SEV_LABELS[e.severity] || 'SEV ' + e.severity}</span>`;
    html += `<span class="badge" style="background:#1A1A2A;color:#7A8AAA">${e.eventType}${e.eventSubtype ? ' / ' + e.eventSubtype : ''}</span>`;
    const regionDisplay = e.regions.length ? collapseRegions(e.regions).join(', ') : '';
    html += `<span class="ev-location">${e.country}${regionDisplay ? ' — ' + regionDisplay : ''}</span>`;
    html += `<span class="ev-verification">${e.verificationStatus}</span>`;
    if (e.primaryUrl) html += `<span class="ev-source-link"><a href="${escHTML(e.primaryUrl)}">source</a></span>`;
    html += '</div>';

    if (e.sourceCount > 1) {
      html += `<div class="ev-sources">${e.sourceCount} articles across ${e.sources.length} sources: ${e.sources.join(', ')}</div>`;
    }
    if (e.rationale) {
      html += `<div class="ev-rationale">${escHTML(e.rationale)}</div>`;
    }
    html += '</div>';
  }

  // Section 3: Hot Regions
  html += '<h2>Hot Regions</h2>';
  if (d.hotRegions.length === 0) {
    html += '<div style="color:#4A4A54; font-size:12px; padding:12px 0">No regional data this period.</div>';
  }
  for (const r of d.hotRegions) {
    if (bw) {
      html += `<div class="region-row"><span style="color:#A0A0A8">${escHTML(r.region)}</span><span style="color:#6A6A74;font-size:12px">${r.count} events (avg sev ${r.avgSeverity})</span></div>`;
    } else {
      const cls = r.change > 0 ? 'change-up' : r.change < 0 ? 'change-down' : 'change-flat';
      html += `<div class="region-row"><span style="color:#A0A0A8">${escHTML(r.region)}</span><span style="color:#6A6A74;font-size:12px">${r.count} events (avg sev ${r.avgSeverity}) <span class="${cls}">${formatChange(r.change, bw)} WoW</span></span></div>`;
    }
  }

  // Section 4: Actor Activity
  html += '<h2>Actor Activity</h2>';
  const spikes = d.actorSpikes.filter((a) => a.change !== 0).slice(0, 10);
  if (spikes.length === 0) {
    html += '<div style="color:#4A4A54; font-size:12px; padding:12px 0">No significant actor changes.</div>';
  }
  const maxMentions = spikes.length > 0 ? spikes[0].thisWeek : 1;
  for (let i = 0; i < spikes.length; i++) {
    const a = spikes[i];
    const isTop = i < 3;
    const barWidth = Math.round((a.thisWeek / maxMentions) * 60);
    if (bw) {
      html += `<div class="actor-row${isTop ? ' top-actor' : ''}"><span class="actor-name">${escHTML(a.actor)}</span><span class="actor-count">${a.thisWeek} mentions<span class="actor-bar" style="width:${barWidth}px"></span></span></div>`;
    } else {
      const cls = a.change > 0 ? 'change-up' : a.change < 0 ? 'change-down' : 'change-flat';
      html += `<div class="actor-row${isTop ? ' top-actor' : ''}"><span class="actor-name">${escHTML(a.actor)}</span><span class="actor-count">${a.thisWeek} mentions (was ${a.lastWeek}) <span class="${cls}">${formatChange(a.change, bw)}</span><span class="actor-bar" style="width:${barWidth}px"></span></span></div>`;
    }
  }

  // Footer — confident, no AI language
  const sourceCount = 16;
  const sevNote = d.dataPoints.highSevRawCount !== d.dataPoints.highSevCount
    ? `${d.dataPoints.highSevRawCount} severity 4-5 events consolidated into ${d.dataPoints.highSevCount} items`
    : `${d.dataPoints.highSevCount} severity 4-5 events`;
  html += `<div class="footer">Structured event extraction across ${sourceCount} monitored sources covering ${d.dataPoints.countriesThisWeek.join(', ') || 'Horn of Africa'}. ${d.dataPoints.eventsThisWeek} events processed, ${sevNote}.</div>`;

  html += '</body></html>';
  return html;
}

// ─── Render to plain text (for API / logging) ──────────────

function renderDigestText(digest) {
  const d = digest;
  const bw = d.topline.baselineWeak;
  let text = '';

  text += `HORN RISK DELTA — WEEK ${d.weekNumber}\n`;
  text += `${d.period.thisWeek}\n`;
  text += `${'─'.repeat(50)}\n\n`;

  text += 'TOPLINE\n';
  if (bw) {
    text += '  (Baseline week — prior data insufficient for trends)\n';
    text += `  Total: ${d.topline.totalThisWeek} events tracked\n`;
  } else {
    text += `  Total: ${d.topline.totalThisWeek} events (${formatChange(d.topline.totalChange, bw)} WoW)\n`;
  }
  for (const t of d.topline.typeShifts) {
    if (bw) {
      text += `  ${t.type}: ${t.thisWeek} (avg sev ${t.avgSeverity})\n`;
    } else {
      text += `  ${t.type}: ${t.thisWeek} (${formatChange(t.change, bw)})\n`;
    }
  }

  text += '\nHIGH-SEVERITY EVENTS\n';
  if (d.highSeverity.length === 0) {
    text += '  (none this week)\n';
  }
  for (const e of d.highSeverity) {
    text += `  [${SEV_LABELS[e.severity] || 'SEV ' + e.severity}] ${e.summary}\n`;
    text += `    ${e.country}${e.regions.length ? ' / ' + collapseRegions(e.regions).join(', ') : ''} | ${e.verificationStatus}`;
    if (e.sourceCount > 1) text += ` | ${e.sourceCount} articles`;
    text += '\n';
    if (e.rationale) text += `    ${e.rationale}\n`;
    text += '\n';
  }

  text += 'HOT REGIONS\n';
  for (const r of d.hotRegions.slice(0, 8)) {
    if (bw) {
      text += `  ${r.region}: ${r.count} events, avg severity ${r.avgSeverity}\n`;
    } else {
      text += `  ${r.region}: ${r.count} events, avg severity ${r.avgSeverity} (${formatChange(r.change, bw)} WoW)\n`;
    }
  }

  text += '\nACTOR ACTIVITY\n';
  const spikes = d.actorSpikes.filter((a) => a.change !== 0).slice(0, 8);
  for (const a of spikes) {
    if (bw) {
      text += `  ${a.actor}: ${a.thisWeek} mentions\n`;
    } else {
      text += `  ${a.actor}: ${a.thisWeek} mentions (${formatChange(a.change, bw)} from ${a.lastWeek})\n`;
    }
  }

  text += `\n${'─'.repeat(50)}\n`;
  text += `Generated from 16 monitored sources | ${d.dataPoints.eventsThisWeek} events | ${d.dataPoints.countriesThisWeek.join(', ')}\n`;

  return text;
}

function escHTML(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { generateDigest, renderDigestHTML, renderDigestText };
