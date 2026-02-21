// ═══════════════════════════════════════════════════════════════
// South Sudan News — Perplexity-inspired client
// ═══════════════════════════════════════════════════════════════

// ─── State ──────────────────────────────────────────────────────
let allClusters = [];
let activeCategory = 'all';
let currentStoryIndex = null;

// ─── DOM elements ───────────────────────────────────────────────
const feedView = document.getElementById('feed-view');
const storyView = document.getElementById('story-view');
const categoryNav = document.getElementById('category-nav');
const storiesEl = document.getElementById('stories');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const emptyEl = document.getElementById('empty');
const sourceCountEl = document.getElementById('source-count');
const footerSourcesEl = document.getElementById('footer-sources');
const lastUpdatedEl = document.getElementById('last-updated');
const refreshBtn = document.getElementById('refresh-btn');
const homeBtn = document.getElementById('home-btn');
const backBtn = document.getElementById('back-btn');
const storyContent = document.getElementById('story-content');
const followupSection = document.getElementById('followup-section');
const followupInput = document.getElementById('followup-input');
const followupSend = document.getElementById('followup-send');
const followupAnswer = document.getElementById('followup-answer');
const discoverSection = document.getElementById('discover-section');
const relatedStories = document.getElementById('related-stories');

// ─── DOM elements (intelligence banner) ─────────────────────────
const intelBanner = document.getElementById('intel-banner');
const intelEvents = document.getElementById('intel-events');
const intelHigh = document.getElementById('intel-high');
const intelRegion = document.getElementById('intel-region');
const intelRegionDivider = document.getElementById('intel-region-divider');
const intelActor = document.getElementById('intel-actor');
const intelActorDivider = document.getElementById('intel-actor-divider');

// ─── Initialize ─────────────────────────────────────────────────
loadNews();
loadIntelligence();

// ─── Event Listeners ────────────────────────────────────────────

// Refresh
refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  await fetch('/api/news/refresh', { method: 'POST' });
  await loadNews();
  refreshBtn.classList.remove('spinning');
});

// Home button
homeBtn.addEventListener('click', () => showFeed());

// Back button
backBtn.addEventListener('click', () => showFeed());

// Category filters
document.querySelectorAll('.category-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelector('.category-btn.active').classList.remove('active');
    btn.classList.add('active');
    activeCategory = btn.dataset.category;
    renderStories();
  });
});

// Follow-up question
followupInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && followupInput.value.trim()) {
    askFollowUp();
  }
});
followupSend.addEventListener('click', () => {
  if (followupInput.value.trim()) {
    askFollowUp();
  }
});

// Browser back/forward
window.addEventListener('popstate', (e) => {
  if (e.state?.view === 'story') {
    openStory(e.state.index, true);
  } else {
    showFeed(true);
  }
});

// ─── Feed Loading ───────────────────────────────────────────────

async function loadNews() {
  showLoading();
  try {
    const res = await fetch('/api/news');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    allClusters = data.clusters || [];

    sourceCountEl.textContent = `${data.sources?.length || 0} sources`;
    footerSourcesEl.textContent = data.sources?.length || 0;
    lastUpdatedEl.textContent = data.lastUpdated
      ? formatTimeAgo(new Date(data.lastUpdated))
      : 'just now';

    if (allClusters.length === 0) {
      showEmpty();
    } else {
      renderStories();
    }
  } catch (err) {
    console.error('Failed to load news:', err);
    showError();
  }
}

// ─── Intelligence Banner ────────────────────────────────────────

async function loadIntelligence() {
  try {
    const res = await fetch('/api/intelligence');
    if (!res.ok) return;
    const data = await res.json();

    if (data.eventsThisWeek > 0) {
      intelEvents.textContent = data.eventsThisWeek;
      intelHigh.textContent = data.highSeverityCount;

      if (data.topRegion) {
        intelRegion.innerHTML = `<strong>${esc(data.topRegion.name)}</strong> highest concentration`;
        intelRegion.style.display = '';
        intelRegionDivider.style.display = '';
      }

      if (data.topActor) {
        intelActor.innerHTML = `<strong>${esc(data.topActor.name)}</strong> most active`;
        intelActor.style.display = '';
        intelActorDivider.style.display = '';
      }

      intelBanner.style.display = 'block';
    }
  } catch (err) {
    // Silently fail — banner is optional enhancement
    console.debug('Intelligence banner not available:', err.message);
  }
}

// ─── Feed Rendering ─────────────────────────────────────────────

function renderStories() {
  const filtered =
    activeCategory === 'all'
      ? allClusters
      : allClusters.filter(
          (c) =>
            c.category === activeCategory ||
            c.articles.some((a) => a.sourceCategory === activeCategory)
        );

  if (filtered.length === 0) {
    storiesEl.innerHTML = '';
    emptyEl.style.display = 'block';
    loadingEl.style.display = 'none';
    errorEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  loadingEl.style.display = 'none';
  errorEl.style.display = 'none';

  // 3-tier layout: hero → featured (severity ≥ 3) → compact grid
  const hero = filtered[0];
  const heroIndex = allClusters.indexOf(hero);
  const rest = filtered.slice(1);

  // Featured: next stories with severity ≥ 3 (up to 2)
  const featured = [];
  const compact = [];
  for (const c of rest) {
    if (featured.length < 2 && c.event && c.event.severity >= 3) {
      featured.push(c);
    } else {
      compact.push(c);
    }
  }

  let html = createHeroCard(hero, heroIndex);

  // Featured row (horizontal cards)
  if (featured.length > 0) {
    html += '<div class="stories-grid-featured">';
    featured.forEach((cluster) => {
      const idx = allClusters.indexOf(cluster);
      html += createFeaturedCard(cluster, idx);
    });
    html += '</div>';
  }

  // Compact grid (smaller cards)
  if (compact.length > 0) {
    html += '<div class="stories-grid-compact">';
    compact.forEach((cluster) => {
      const idx = allClusters.indexOf(cluster);
      html += createCompactCard(cluster, idx);
    });
    html += '</div>';
  }

  storiesEl.innerHTML = html;

  // Attach click handlers
  storiesEl.querySelectorAll('[data-story-index]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const idx = parseInt(el.dataset.storyIndex);
      openStory(idx);
    });
  });
}

// Category-based placeholder colors for cards without images
const PLACEHOLDER_THEMES = {
  security:      { bg: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)', accent: '#e94560', icon: '\u26A0' },
  humanitarian:  { bg: 'linear-gradient(135deg, #1a1a2e 0%, #1e2d3d 50%, #1a3a4a 100%)', accent: '#4ecdc4', icon: '\u2764' },
  political:     { bg: 'linear-gradient(135deg, #1a1a2e 0%, #2d1f3d 50%, #3a1a4a 100%)', accent: '#9b59b6', icon: '\u2691' },
  economic:      { bg: 'linear-gradient(135deg, #1a1a2e 0%, #2d2d1f 50%, #4a4a1a 100%)', accent: '#f39c12', icon: '\u25B2' },
  general:       { bg: 'linear-gradient(135deg, #1e293b 0%, #334155 50%, #1e293b 100%)', accent: '#64748b', icon: '\u25CF' },
  legal:         { bg: 'linear-gradient(135deg, #1a1a2e 0%, #1f2d3d 50%, #1a3a4a 100%)', accent: '#3498db', icon: '\u2696' },
  infrastructure:{ bg: 'linear-gradient(135deg, #1a1a2e 0%, #2d2d1f 50%, #3a3a1a 100%)', accent: '#e67e22', icon: '\u2302' },
};

function buildPlaceholder(cluster, height) {
  const category = cluster.category || 'general';
  const theme = PLACEHOLDER_THEMES[category] || PLACEHOLDER_THEMES.general;
  const primary = cluster.primaryArticle;
  const domain = getDomain(primary.url);
  return `<div style="width:100%;height:${height}px;background:${theme.bg};display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden">
    <span style="font-size:${height > 200 ? 48 : 36}px;opacity:0.12;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)">${theme.icon}</span>
    <div style="position:absolute;bottom:12px;left:16px;display:flex;align-items:center;gap:8px">
      ${domain ? `<img src="https://www.google.com/s2/favicons?domain=${esc(domain)}&sz=16" alt="" style="opacity:0.6" onerror="this.style.display='none'">` : ''}
      <span style="font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:0.5px;text-transform:uppercase">${esc(primary.source)}</span>
    </div>
    <span style="position:absolute;top:12px;right:16px;font-size:10px;padding:2px 8px;border-radius:3px;background:${theme.accent};color:rgba(0,0,0,0.7);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">${esc(category)}</span>
  </div>`;
}

function createHeroCard(cluster, index) {
  const primary = cluster.primaryArticle;
  const timeAgo = formatTimeAgo(new Date(cluster.latestDate));
  const category = cluster.category || 'general';
  const event = cluster.event;
  const sevClass = event ? `severity-${event.severity}` : '';

  const imageHtml = cluster.image
    ? `<div class="hero-image-wrap">
        <img src="${esc(cluster.image)}" alt="" loading="lazy" onerror="this.style.display='none'">
        <span class="hero-image-source">${esc(primary.source)}</span>
      </div>`
    : `<div class="hero-image-wrap">${buildPlaceholder(cluster, 320)}</div>`;

  const sourcesHtml = buildSourceFavicons(cluster.articles, 4);
  const intelTagsHtml = buildIntelTags(event);

  return `
    <div class="story-card hero ${sevClass}" data-story-index="${index}">
      ${imageHtml}
      <div class="hero-body">
        <h2 class="story-title">${esc(primary.title)}</h2>
        ${cluster.summary ? `<p class="story-summary">${esc(cluster.summary)}</p>` : ''}
        ${intelTagsHtml}
        <div class="story-meta">
          <div class="story-sources-row">
            ${event && event.severity >= 3 ? `<span class="severity-label sev-${event.severity}"><span class="severity-dot sev-${event.severity}"></span>Severity ${event.severity}</span>` : ''}
            ${sourcesHtml}
            <span class="source-count-badge">${cluster.sourceCount} source${cluster.sourceCount !== 1 ? 's' : ''}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            ${event ? buildVerificationBadge(event.verificationStatus) : ''}
            <span class="story-category-badge ${category}">${category}</span>
            <span class="story-time">${timeAgo}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function createRegularCard(cluster, index) {
  const primary = cluster.primaryArticle;
  const timeAgo = formatTimeAgo(new Date(cluster.latestDate));
  const category = cluster.category || 'general';
  const event = cluster.event;
  const sevClass = event ? `severity-${event.severity}` : '';

  const imageHtml = cluster.image
    ? `<div class="card-image-wrap">
        <img src="${esc(cluster.image)}" alt="" loading="lazy" onerror="this.style.display='none'">
      </div>`
    : `<div class="card-image-wrap">${buildPlaceholder(cluster, 180)}</div>`;

  const sourcesHtml = buildSourceFavicons(cluster.articles, 3);
  const intelTagsHtml = buildIntelTags(event, true);

  return `
    <div class="story-card regular ${sevClass}" data-story-index="${index}">
      ${imageHtml}
      <div class="card-body">
        <h3 class="story-title">${esc(primary.title)}</h3>
        ${cluster.summary ? `<p class="story-summary">${esc(cluster.summary)}</p>` : ''}
        ${intelTagsHtml}
        <div class="story-meta">
          <div class="story-sources-row">
            ${event && event.severity >= 3 ? `<span class="severity-dot sev-${event.severity}"></span>` : ''}
            ${sourcesHtml}
            <span class="source-count-badge">${cluster.sourceCount}s</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            ${event ? buildVerificationBadge(event.verificationStatus) : ''}
            <span class="story-time">${timeAgo}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function createFeaturedCard(cluster, index) {
  const primary = cluster.primaryArticle;
  const timeAgo = formatTimeAgo(new Date(cluster.latestDate));
  const event = cluster.event;
  const sevClass = event ? `severity-${event.severity}` : '';

  const imageHtml = cluster.image
    ? `<div class="featured-image-wrap">
        <img src="${esc(cluster.image)}" alt="" loading="lazy" onerror="this.style.display='none'">
      </div>`
    : `<div class="featured-image-wrap">${buildPlaceholder(cluster, 180)}</div>`;

  const intelTagsHtml = buildIntelTags(event, true);

  return `
    <div class="story-card featured ${sevClass}" data-story-index="${index}">
      ${imageHtml}
      <div class="featured-body">
        <h3 class="story-title">${esc(primary.title)}</h3>
        ${cluster.summary ? `<p class="story-summary">${esc(cluster.summary)}</p>` : ''}
        ${intelTagsHtml}
        <div class="story-meta">
          <div class="story-sources-row">
            ${event && event.severity >= 3 ? `<span class="severity-dot sev-${event.severity}"></span>` : ''}
            <span class="source-count-badge">${cluster.sourceCount} source${cluster.sourceCount !== 1 ? 's' : ''}</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            ${event ? buildVerificationBadge(event.verificationStatus) : ''}
            <span class="story-time">${timeAgo}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function createCompactCard(cluster, index) {
  const primary = cluster.primaryArticle;
  const timeAgo = formatTimeAgo(new Date(cluster.latestDate));
  const event = cluster.event;
  const sevClass = event ? `severity-${event.severity}` : '';

  const imageHtml = cluster.image
    ? `<div class="compact-image-wrap">
        <img src="${esc(cluster.image)}" alt="" loading="lazy" onerror="this.style.display='none'">
      </div>`
    : `<div class="compact-image-wrap">${buildPlaceholder(cluster, 120)}</div>`;

  return `
    <div class="story-card compact ${sevClass}" data-story-index="${index}">
      ${imageHtml}
      <div class="compact-body">
        <h3 class="story-title">${esc(primary.title)}</h3>
        <div class="story-meta">
          <div class="story-sources-row">
            ${event && event.severity >= 3 ? `<span class="severity-dot sev-${event.severity}"></span>` : ''}
            ${event ? buildVerificationBadge(event.verificationStatus) : ''}
            <span class="source-count-badge">${cluster.sourceCount}s</span>
          </div>
          <span class="story-time">${timeAgo}</span>
        </div>
      </div>
    </div>
  `;
}

// ─── Story Detail View ──────────────────────────────────────────

function openStory(index, fromPopstate) {
  currentStoryIndex = index;
  const cluster = allClusters[index];
  if (!cluster) return;

  // Show story view
  feedView.style.display = 'none';
  categoryNav.style.display = 'none';
  storyView.style.display = 'block';

  // Reset follow-up state
  followupAnswer.style.display = 'none';
  followupAnswer.innerHTML = '';
  followupInput.value = '';

  // Scroll to top
  window.scrollTo({ top: 0 });

  // Push history state
  if (!fromPopstate) {
    history.pushState({ view: 'story', index }, '', `#story-${index}`);
  }

  // Show skeleton loading
  storyContent.innerHTML = buildSkeleton(cluster);

  // Show discover more immediately (from cached data)
  renderDiscoverMore(index);

  // Fetch deep summary
  fetchDeepSummary(index, cluster);
}

async function fetchDeepSummary(index, cluster) {
  try {
    const res = await fetch(`/api/story/${index}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    renderStoryDetail(data);
  } catch (err) {
    console.error('Failed to load deep summary:', err);
    // Render with what we have from the feed
    renderStoryDetail({
      ...cluster,
      deepSummary: null,
    });
  }
}

function renderStoryDetail(data) {
  const primary = data.primaryArticle;
  const timeAgo = formatTimeAgo(new Date(data.latestDate));
  const deepSummary = data.deepSummary;

  const event = data.event;

  // Header
  let html = `<div class="story-detail-header">`;
  html += `<h1 class="story-detail-title">${esc(primary.title)}</h1>`;
  html += `<div class="story-detail-meta">`;
  if (event && event.severity >= 3) {
    html += `<span class="severity-label sev-${event.severity}"><span class="severity-dot sev-${event.severity}"></span>Severity ${event.severity}/5</span>`;
    html += `<span class="detail-dot"></span>`;
  }
  html += `<span class="detail-time">Published ${timeAgo}</span>`;
  html += `<span class="detail-dot"></span>`;
  html += `<span class="detail-source-count">${data.sourceCount} source${data.sourceCount !== 1 ? 's' : ''}</span>`;
  if (event && event.verificationStatus) {
    html += `<span class="detail-dot"></span>`;
    html += buildVerificationBadge(event.verificationStatus);
  }
  html += `</div>`;
  // Intelligence tags (regions + actors)
  if (event) {
    html += buildIntelTags(event, false);
  }

  // Source favicons row
  html += `<div class="story-detail-sources">`;
  const uniqueSources = getUniqueSources(data.articles);
  uniqueSources.forEach((a) => {
    const domain = getDomain(a.url);
    html += `<a href="${esc(a.url)}" target="_blank" rel="noopener" class="source-favicon">`;
    if (domain) html += `<img src="https://www.google.com/s2/favicons?domain=${esc(domain)}&sz=16" alt="" onerror="this.style.display='none'">`;
    html += `${esc(a.source)}</a>`;
  });
  html += `</div>`;
  html += `</div>`;

  // Hero image
  if (data.image) {
    const imageSource = data.articles.find((a) => a.image === data.image);
    html += `<div class="detail-hero-image">`;
    html += `<img src="${esc(data.image)}" alt="" onerror="this.parentElement.style.display='none'">`;
    if (imageSource) {
      html += `<span class="detail-image-source">${esc(imageSource.source)}</span>`;
    }
    html += `</div>`;
  }

  // Sections
  if (deepSummary && deepSummary.sections) {
    deepSummary.sections.forEach((section) => {
      html += `<div class="story-section">`;
      html += `<h2 class="story-section-heading">${esc(section.heading)}</h2>`;
      html += `<div class="story-section-content">${renderMarkdown(section.content)}</div>`;

      // Section sources
      if (section.sources && section.sources.length > 0) {
        html += `<div class="section-sources">`;
        section.sources.forEach((src) => {
          const domain = getDomain(src.url);
          html += `<a href="${esc(src.url)}" target="_blank" rel="noopener" class="section-source-tag">`;
          if (domain) html += `<img src="https://www.google.com/s2/favicons?domain=${esc(domain)}&sz=16" alt="" onerror="this.style.display='none'">`;
          html += `${esc(domain || src.name)}</a>`;
        });
        html += `</div>`;
      }

      html += `</div>`;
    });
  } else if (data.summary) {
    // Fallback: show the short summary if no deep summary
    html += `<div class="story-section">`;
    html += `<div class="story-section-content"><p>${esc(data.summary)}</p></div>`;
    html += `</div>`;
  }

  storyContent.innerHTML = html;
}

function buildSkeleton(cluster) {
  const primary = cluster.primaryArticle;
  const timeAgo = formatTimeAgo(new Date(cluster.latestDate));

  // Show real title + meta but skeleton for body
  let html = `<div class="story-detail-header">`;
  html += `<h1 class="story-detail-title">${esc(primary.title)}</h1>`;
  html += `<div class="story-detail-meta">`;
  html += `<span class="detail-time">Published ${timeAgo}</span>`;
  html += `<span class="detail-dot"></span>`;
  html += `<span class="detail-source-count">${cluster.sourceCount} source${cluster.sourceCount !== 1 ? 's' : ''}</span>`;
  html += `</div>`;

  // Source favicons
  html += `<div class="story-detail-sources">`;
  const uniqueSources = getUniqueSources(cluster.articles);
  uniqueSources.forEach((a) => {
    const domain = getDomain(a.url);
    html += `<a href="${esc(a.url)}" target="_blank" rel="noopener" class="source-favicon">`;
    if (domain) html += `<img src="https://www.google.com/s2/favicons?domain=${esc(domain)}&sz=16" alt="" onerror="this.style.display='none'">`;
    html += `${esc(a.source)}</a>`;
  });
  html += `</div></div>`;

  // Real image if available
  if (cluster.image) {
    html += `<div class="detail-hero-image">`;
    html += `<img src="${esc(cluster.image)}" alt="" onerror="this.parentElement.style.display='none'">`;
    html += `</div>`;
  }

  // Skeleton sections
  html += `<div class="skeleton-wrap">`;
  for (let i = 0; i < 3; i++) {
    html += `
      <div style="margin-bottom:28px">
        <div class="skeleton-bar skeleton-heading"></div>
        <div class="skeleton-bar skeleton-line"></div>
        <div class="skeleton-bar skeleton-line"></div>
        <div class="skeleton-bar skeleton-line short"></div>
        <div class="skeleton-bar skeleton-line shorter"></div>
      </div>
    `;
  }
  html += `</div>`;

  return html;
}

// ─── Discover More ──────────────────────────────────────────────

function renderDiscoverMore(currentIndex) {
  const others = allClusters
    .map((c, i) => ({ cluster: c, index: i }))
    .filter((item) => item.index !== currentIndex)
    .slice(0, 4);

  if (others.length === 0) {
    discoverSection.style.display = 'none';
    return;
  }

  discoverSection.style.display = 'block';

  relatedStories.innerHTML = others
    .map(({ cluster, index }) => {
      const primary = cluster.primaryArticle;
      const snippet = cluster.summary || primary.description || '';

      const imgHtml = cluster.image
        ? `<div class="related-card-image"><img src="${esc(cluster.image)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
        : `<div class="related-card-image">${buildPlaceholder(cluster, 100)}</div>`;

      return `
        <div class="related-card" data-related-index="${index}">
          ${imgHtml}
          <div class="related-card-text">
            <div class="related-card-title">${esc(primary.title)}</div>
            <div class="related-card-snippet">${esc(snippet.slice(0, 120))}${snippet.length > 120 ? '...' : ''}</div>
            <div class="related-card-sources">${cluster.sourceCount} source${cluster.sourceCount !== 1 ? 's' : ''}</div>
          </div>
        </div>
      `;
    })
    .join('');

  // Attach click handlers
  relatedStories.querySelectorAll('[data-related-index]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.relatedIndex);
      openStory(idx);
    });
  });
}

// ─── Follow-up Questions ────────────────────────────────────────

async function askFollowUp() {
  const question = followupInput.value.trim();
  if (!question || currentStoryIndex === null) return;

  // Show loading
  followupAnswer.style.display = 'block';
  followupAnswer.innerHTML = `<div class="followup-loading"><div class="spinner"></div>Thinking...</div>`;

  try {
    const res = await fetch('/api/followup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        storyIndex: currentStoryIndex,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    followupAnswer.innerHTML = renderMarkdown(data.answer);
  } catch (err) {
    console.error('Follow-up failed:', err);
    followupAnswer.innerHTML = '<p>Failed to get an answer. Please try again.</p>';
  }
}

// ─── View Navigation ────────────────────────────────────────────

function showFeed(fromPopstate) {
  feedView.style.display = 'block';
  categoryNav.style.display = 'block';
  storyView.style.display = 'none';
  currentStoryIndex = null;

  if (!fromPopstate) {
    history.pushState({ view: 'feed' }, '', '#');
  }
}

function showLoading() {
  loadingEl.style.display = 'flex';
  errorEl.style.display = 'none';
  emptyEl.style.display = 'none';
  storiesEl.innerHTML = '';
}

function showError() {
  loadingEl.style.display = 'none';
  errorEl.style.display = 'block';
  emptyEl.style.display = 'none';
}

function showEmpty() {
  loadingEl.style.display = 'none';
  errorEl.style.display = 'none';
  emptyEl.style.display = 'block';
}

// ─── Intelligence Helpers ────────────────────────────────────────

function buildIntelTags(event, compact) {
  if (!event) return '';
  const tags = [];

  // Regions (max 2)
  if (event.regions && event.regions.length > 0) {
    event.regions.slice(0, compact ? 1 : 2).forEach((r) => {
      tags.push(`<span class="intel-tag region">${esc(r)}</span>`);
    });
  }

  // Actors (max 2, or 1 in compact mode)
  if (event.actors && event.actors.length > 0) {
    event.actors.slice(0, compact ? 1 : 2).forEach((a) => {
      tags.push(`<span class="intel-tag actor">${esc(a)}</span>`);
    });
  }

  if (tags.length === 0) return '';
  return `<div class="intel-tags">${tags.join('')}</div>`;
}

function buildVerificationBadge(status) {
  if (!status) return '';
  return `<span class="intel-tag verification ${status}">${esc(status)}</span>`;
}

// ─── Helpers ────────────────────────────────────────────────────

function buildSourceFavicons(articles, maxCount) {
  const unique = getUniqueSources(articles);
  return unique
    .slice(0, maxCount)
    .map((a) => {
      const domain = getDomain(a.url);
      let html = `<span class="source-favicon">`;
      if (domain) html += `<img src="https://www.google.com/s2/favicons?domain=${esc(domain)}&sz=16" alt="" onerror="this.style.display='none'">`;
      html += `${esc(a.source)}</span>`;
      return html;
    })
    .join('');
}

function getUniqueSources(articles) {
  const seen = new Set();
  return articles.filter((a) => {
    if (seen.has(a.source)) return false;
    seen.add(a.source);
    return true;
  });
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function renderMarkdown(text) {
  if (!text) return '';
  // Convert **bold** to <strong>, then handle paragraphs
  let html = esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br>');
  return `<p>${html}</p>`;
}

function formatTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
