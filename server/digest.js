// Weekly Risk Delta generator
// Computes week-over-week changes and produces a structured intelligence digest.
// Output: structured data object + pre-rendered HTML for email/dashboard preview.

const {
  getEventsForPeriod,
  getTypeCountsForPeriod,
  getRegionSeverityForPeriod,
  getActorCountsForPeriod,
} = require('./db');

// ─── Helpers ────────────────────────────────────────────────────

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

function formatChange(pct) {
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

// ─── Main digest generator ──────────────────────────────────────

function generateDigest() {
  const thisWeek = getWeekBounds(0);
  const lastWeek = getWeekBounds(1);

  // Events
  const twEvents = getEventsForPeriod(thisWeek.start, thisWeek.end);
  const lwEvents = getEventsForPeriod(lastWeek.start, lastWeek.end);

  // Type counts
  const twTypes = getTypeCountsForPeriod(thisWeek.start, thisWeek.end);
  const lwTypes = getTypeCountsForPeriod(lastWeek.start, lastWeek.end);

  // Region severity
  const twRegions = getRegionSeverityForPeriod(thisWeek.start, thisWeek.end);
  const lwRegions = getRegionSeverityForPeriod(lastWeek.start, lastWeek.end);

  // Actor counts
  const twActors = getActorCountsForPeriod(thisWeek.start, thisWeek.end);
  const lwActors = getActorCountsForPeriod(lastWeek.start, lastWeek.end);

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
    typeShifts,
  };

  // ── Section 2: High-Severity Events ───────────────────────
  const highSeverity = twEvents
    .filter((e) => e.severity >= 4)
    .slice(0, 8)
    .map((e) => ({
      summary: e.summary,
      severity: e.severity,
      eventType: e.event_type,
      eventSubtype: e.event_subtype,
      country: e.country,
      regions: safeJSON(e.regions),
      actors: safeJSON(e.actors_normalized || e.actors),
      rationale: e.rationale,
      verificationStatus: e.verification_status,
      confidence: e.confidence,
      primaryUrl: e.primary_url,
      publishedAt: e.published_at,
    }));

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
      countriesThisWeek: [...new Set(twEvents.map((e) => e.country))],
    },
  };
}

function safeJSON(s) {
  if (Array.isArray(s)) return s;
  try { return JSON.parse(s || '[]'); } catch { return []; }
}

// ─── Render to HTML (for email / dashboard preview) ─────────

const SEV_LABELS = { 1: 'Routine', 2: 'Notable', 3: 'Significant', 4: 'Major', 5: 'Critical' };

function renderDigestHTML(digest) {
  const d = digest;

  let html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d0d12; color: #d0d0d0; max-width: 680px; margin: 0 auto; padding: 32px 24px; line-height: 1.6; }
h1 { font-size: 20px; color: #fff; margin-bottom: 4px; }
.subtitle { color: #666; font-size: 13px; margin-bottom: 32px; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin: 28px 0 14px 0; padding-bottom: 6px; border-bottom: 1px solid #1a1a2a; }
.topline-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #111118; font-size: 14px; }
.topline-type { color: #bbb; }
.topline-nums { color: #888; font-size: 13px; }
.change-up { color: #e74c3c; font-weight: 600; }
.change-down { color: #2ecc71; font-weight: 600; }
.change-flat { color: #666; }
.event-card { background: #111118; border-left: 4px solid #e74c3c; border-radius: 6px; padding: 14px 18px; margin-bottom: 12px; }
.event-card.sev-5 { border-left-color: #c0392b; background: #130a0a; }
.event-card .ev-summary { font-size: 14px; color: #ddd; font-weight: 500; margin-bottom: 6px; }
.event-card .ev-meta { font-size: 12px; color: #777; }
.event-card .ev-rationale { font-size: 12px; color: #666; font-style: italic; margin-top: 6px; }
.region-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #111118; font-size: 13px; }
.actor-row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #111118; font-size: 13px; }
.badge { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 4px; margin-right: 6px; }
.badge-sev { background: #3a1a1a; color: #e74c3c; }
.badge-type { background: #1a1a2e; color: #3498db; }
.footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #1a1a2a; font-size: 11px; color: #444; }
a { color: #3498db; text-decoration: none; }
</style></head><body>`;

  html += `<h1>Horn Risk Delta — Week ${d.weekNumber}</h1>`;
  html += `<div class="subtitle">${d.period.thisWeek} | Generated ${new Date(d.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>`;

  // Section 1: Topline
  html += '<h2>Topline Shift</h2>';
  const totalChangeClass = d.topline.totalChange > 0 ? 'change-up' : d.topline.totalChange < 0 ? 'change-down' : 'change-flat';
  html += `<div class="topline-row"><span class="topline-type" style="font-weight:600">Total Events</span><span class="topline-nums">${d.topline.totalThisWeek} this week vs ${d.topline.totalLastWeek} last week <span class="${totalChangeClass}">${formatChange(d.topline.totalChange)}</span></span></div>`;

  for (const t of d.topline.typeShifts) {
    const cls = t.change > 0 ? 'change-up' : t.change < 0 ? 'change-down' : 'change-flat';
    html += `<div class="topline-row"><span class="topline-type">${t.type}</span><span class="topline-nums">${t.thisWeek} vs ${t.lastWeek} <span class="${cls}">${formatChange(t.change)}</span></span></div>`;
  }

  // Section 2: High-Severity Events
  html += '<h2>High-Severity Events</h2>';
  if (d.highSeverity.length === 0) {
    html += '<div style="color:#555; font-size:13px; padding:12px 0">No severity 4-5 events this week</div>';
  }
  for (const e of d.highSeverity) {
    const sevClass = e.severity >= 5 ? 'sev-5' : '';
    html += `<div class="event-card ${sevClass}">`;
    html += `<div class="ev-summary">${escHTML(e.summary)}</div>`;
    html += `<div class="ev-meta">`;
    html += `<span class="badge badge-sev">SEV ${e.severity}</span>`;
    html += `<span class="badge badge-type">${e.eventType}${e.eventSubtype ? '/' + e.eventSubtype : ''}</span>`;
    html += `${e.country}${e.regions.length ? ' / ' + e.regions.join(', ') : ''} `;
    html += `| ${e.verificationStatus} | conf ${e.confidence}`;
    if (e.primaryUrl) html += ` | <a href="${escHTML(e.primaryUrl)}">source</a>`;
    html += '</div>';
    if (e.rationale) html += `<div class="ev-rationale">"${escHTML(e.rationale)}"</div>`;
    html += '</div>';
  }

  // Section 3: Hot Regions
  html += '<h2>Hot Regions</h2>';
  if (d.hotRegions.length === 0) {
    html += '<div style="color:#555; font-size:13px; padding:12px 0">No regional data this week</div>';
  }
  for (const r of d.hotRegions) {
    const cls = r.change > 0 ? 'change-up' : r.change < 0 ? 'change-down' : 'change-flat';
    html += `<div class="region-row"><span style="color:#bbb">${escHTML(r.region)}</span><span style="color:#888">${r.count} events (avg sev ${r.avgSeverity}) <span class="${cls}">${formatChange(r.change)} WoW</span></span></div>`;
  }

  // Section 4: Actor Spikes
  html += '<h2>Actor Spikes</h2>';
  const spikes = d.actorSpikes.filter((a) => a.change !== 0).slice(0, 10);
  if (spikes.length === 0) {
    html += '<div style="color:#555; font-size:13px; padding:12px 0">No significant actor changes</div>';
  }
  for (const a of spikes) {
    const cls = a.change > 0 ? 'change-up' : a.change < 0 ? 'change-down' : 'change-flat';
    html += `<div class="actor-row"><span style="color:#bbb">${escHTML(a.actor)}</span><span style="color:#888">${a.thisWeek} mentions (was ${a.lastWeek}) <span class="${cls}">${formatChange(a.change)}</span></span></div>`;
  }

  // Footer
  html += `<div class="footer">Horn Monitor Risk Delta — auto-generated from ${d.dataPoints.eventsThisWeek} events across ${d.dataPoints.countriesThisWeek.join(', ') || 'N/A'}. Data quality: ${d.dataPoints.highSevCount} high-severity events flagged. This report is machine-generated from structured news extraction and should be verified against primary sources.</div>`;

  html += '</body></html>';
  return html;
}

// ─── Render to plain text (for API / logging) ──────────────

function renderDigestText(digest) {
  const d = digest;
  let text = '';

  text += `HORN RISK DELTA — WEEK ${d.weekNumber}\n`;
  text += `${d.period.thisWeek}\n`;
  text += `${'─'.repeat(50)}\n\n`;

  text += 'TOPLINE SHIFT\n';
  text += `  Total: ${d.topline.totalThisWeek} events (${formatChange(d.topline.totalChange)} WoW)\n`;
  for (const t of d.topline.typeShifts) {
    text += `  ${t.type}: ${t.thisWeek} (${formatChange(t.change)})\n`;
  }

  text += '\nHIGH-SEVERITY EVENTS\n';
  if (d.highSeverity.length === 0) {
    text += '  (none this week)\n';
  }
  for (const e of d.highSeverity) {
    text += `  [SEV ${e.severity}] ${e.summary}\n`;
    text += `    ${e.country}${e.regions.length ? ' / ' + e.regions.join(', ') : ''} | ${e.verificationStatus}\n`;
    if (e.rationale) text += `    Rationale: ${e.rationale}\n`;
    text += '\n';
  }

  text += 'HOT REGIONS\n';
  for (const r of d.hotRegions.slice(0, 8)) {
    text += `  ${r.region}: ${r.count} events, avg severity ${r.avgSeverity} (${formatChange(r.change)} WoW)\n`;
  }

  text += '\nACTOR SPIKES\n';
  const spikes = d.actorSpikes.filter((a) => a.change !== 0).slice(0, 8);
  for (const a of spikes) {
    text += `  ${a.actor}: ${a.thisWeek} mentions (${formatChange(a.change)} from ${a.lastWeek})\n`;
  }

  text += `\n${'─'.repeat(50)}\n`;
  text += `Auto-generated | ${d.dataPoints.eventsThisWeek} events | ${d.dataPoints.countriesThisWeek.join(', ')}\n`;

  return text;
}

function escHTML(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { generateDigest, renderDigestHTML, renderDigestText };
