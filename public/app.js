// State
let allClusters = [];
let activeCategory = 'all';

// DOM elements
const storiesEl = document.getElementById('stories');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const emptyEl = document.getElementById('empty');
const sourceCountEl = document.getElementById('source-count');
const footerSourcesEl = document.getElementById('footer-sources');
const lastUpdatedEl = document.getElementById('last-updated');
const refreshBtn = document.getElementById('refresh-btn');

// Load news on startup
loadNews();

// Refresh button
refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  await fetch('/api/news/refresh', { method: 'POST' });
  await loadNews();
  refreshBtn.classList.remove('spinning');
});

// Category filters
document.querySelectorAll('.category-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelector('.category-btn.active').classList.remove('active');
    btn.classList.add('active');
    activeCategory = btn.dataset.category;
    renderStories();
  });
});

async function loadNews() {
  showLoading();
  try {
    const res = await fetch('/api/news');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    allClusters = data.clusters || [];

    // Update metadata
    sourceCountEl.textContent = `${data.sources?.length || 0} sources`;
    footerSourcesEl.textContent = data.sources?.length || 0;
    lastUpdatedEl.textContent = data.lastUpdated ? formatTimeAgo(new Date(data.lastUpdated)) : 'just now';

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

function renderStories() {
  const filtered =
    activeCategory === 'all'
      ? allClusters
      : allClusters.filter((c) => c.category === activeCategory || c.articles.some((a) => a.sourceCategory === activeCategory));

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

  storiesEl.innerHTML = filtered.map((cluster, i) => createStoryCard(cluster, i === 0)).join('');
}

function createStoryCard(cluster, featured) {
  const primary = cluster.primaryArticle;
  const timeAgo = formatTimeAgo(new Date(cluster.latestDate));
  const category = cluster.category || 'general';

  // Source tags (show up to 4 unique sources)
  const sourceTags = cluster.articles
    .reduce((acc, a) => {
      if (!acc.find((x) => x.source === a.source)) {
        acc.push(a);
      }
      return acc;
    }, [])
    .slice(0, 4)
    .map((a) => `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener" class="source-tag">${escapeHtml(a.source)}</a>`)
    .join('');

  const extraCount = cluster.sourceCount > 4 ? `<span class="story-source-count">+${cluster.sourceCount - 4} more</span>` : '';

  const summaryHtml = cluster.summary
    ? `<p class="story-summary">${escapeHtml(cluster.summary)}</p>`
    : '';

  const imageHtml = cluster.image
    ? `<div class="story-image"><img src="${escapeHtml(cluster.image)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : '';

  return `
    <article class="story-card${featured ? ' featured' : ''}">
      <div class="story-header">
        <span class="story-category ${category}">${category}</span>
        <span class="story-time">${timeAgo}</span>
      </div>
      <div class="story-body">
        <div class="story-text">
          <h2 class="story-title">
            <a href="${escapeHtml(primary.url)}" target="_blank" rel="noopener">${escapeHtml(primary.title)}</a>
          </h2>
          ${summaryHtml}
        </div>
        ${imageHtml}
      </div>
      <div class="story-footer">
        <div class="story-sources">
          ${sourceTags}
          ${extraCount}
        </div>
        ${cluster.articles.length > 1
          ? `<div class="story-links"><a href="${escapeHtml(primary.url)}" target="_blank" rel="noopener">Read full coverage</a></div>`
          : ''}
      </div>
    </article>
  `;
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

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
