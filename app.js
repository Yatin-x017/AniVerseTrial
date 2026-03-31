'use strict';

// ─── CONFIG ──────────────────────────────────────────────
const BASE_URL    = 'https://api.jikan.moe/v4';
const STORAGE_KEY = 'aniverse_watchlist_v2';

// ─── STATE ───────────────────────────────────────────────
const state = {
  watchlist:    JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'),
  currentAnime: null,
  topAll:       [],   // full list for expand
  airingAll:    [],
  topPage:      1,
  airingPage:   1,
};

// Cache & lookup
const cache    = new Map();
const animeMap = new Map();

// ─── DOM ─────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const dom = {
  topRow:        $('top-rated-row'),
  topGrid:       $('top-rated-grid'),
  topMore:       $('top-rated-more'),
  airingRow:     $('airing-row'),
  airingGrid:    $('airing-grid'),
  airingMore:    $('airing-more'),
  resultsGrid:   $('results-grid'),
  resultsSection:$('results-section'),
  defaultView:   $('default-view'),
  emptyState:    $('empty-state'),
  searchInput:   $('search-input'),
  filterSearch:  $('filter-search'),
  filterGenre:   $('filter-genre'),
  filterStatus:  $('filter-status'),
  filterSort:    $('filter-sort'),
  filterScore:   $('filter-score'),
  scoreDisplay:  $('score-display'),
  modalOverlay:  $('modal-overlay'),
  modalClose:    $('modal-close'),
  toast:         $('toast'),
  heroBtn:       $('hero-wl-btn'),
  heroImg:       $('hero-img'),
  wlPanel:       $('wl-panel'),
  wlOverlay:     $('wl-overlay'),
  wlClose:       $('wl-close'),
  wlList:        $('wl-list'),
  wlCount:       $('wl-count'),
  wlBadge:       $('wl-badge'),
  searchToggle:  $('search-toggle'),
  searchDropdown:$('search-dropdown'),
  searchClear:   $('search-clear'),
};

// ─── UTILS ───────────────────────────────────────────────
const saveWatchlist  = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state.watchlist));
const isInWatchlist  = id => state.watchlist.some(a => a.mal_id === id);
const cacheAnimeList = list => list.forEach(a => animeMap.set(a.mal_id, a));

function showToast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.add('show');
  setTimeout(() => dom.toast.classList.remove('show'), 2200);
}

function updateBadge() {
  const n = state.watchlist.length;
  dom.wlBadge.textContent = n;
  dom.wlBadge.style.display = n ? 'flex' : 'none';
  dom.wlCount.textContent = n;
}

// ─── API ─────────────────────────────────────────────────
async function apiFetch(endpoint) {
  if (cache.has(endpoint)) return cache.get(endpoint);
  await sleep(400); // Jikan rate-limit safety
  const res = await fetch(BASE_URL + endpoint);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  cache.set(endpoint, data);
  return data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── SKELETON ────────────────────────────────────────────
function showSkeleton(container, count = 6) {
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const s = document.createElement('div');
    s.className = 'skeleton';
    container.appendChild(s);
  }
}

// ─── CARD ────────────────────────────────────────────────
function createCard(anime) {
  const card = document.createElement('div');
  card.className = 'anime-card';

  const img  = anime.images?.jpg?.image_url;
  const inWl = isInWatchlist(anime.mal_id);

  card.innerHTML = `
    ${img
      ? `<img src="${img}" class="card-poster" loading="lazy" alt="${escHtml(anime.title)}" />`
      : `<div class="card-poster-placeholder">?</div>`}
    <div class="card-overlay"></div>
    <button class="card-heart ${inWl ? 'active' : ''}" data-id="${anime.mal_id}" aria-label="Toggle watchlist">
      ${inWl ? '❤' : '♡'}
    </button>
    <div class="card-info">
      <div class="card-title">${escHtml(anime.title)}</div>
      <div class="card-score">★ ${anime.score ?? '—'}</div>
    </div>
  `;

  card.addEventListener('click', e => {
    if (e.target.closest('.card-heart')) return;
    openModal(anime);
  });

  return card;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ─── RENDER ──────────────────────────────────────────────
function render(container, list) {
  container.innerHTML = '';
  list.forEach(a => container.appendChild(createCard(a)));
}

function appendCards(container, list) {
  list.forEach(a => container.appendChild(createCard(a)));
}

// ─── LOAD: TOP RATED ─────────────────────────────────────
async function loadTop() {
  showSkeleton(dom.topRow, 6);
  try {
    const { data } = await apiFetch('/top/anime?limit=24');
    cacheAnimeList(data);
    state.topAll = data;
    render(dom.topRow, data.slice(0, 6));
    initHero(data);  // ← feed top anime into the hero carousel
  } catch(e) {
    dom.topRow.innerHTML = `<p style="color:var(--text-3);font-size:13px;padding:20px 0;">Failed to load. Try refreshing.</p>`;
  }
}

// ─── LOAD: AIRING ────────────────────────────────────────
async function loadAiring() {
  showSkeleton(dom.airingRow, 6);
  try {
    const { data } = await apiFetch('/seasons/now?limit=24');
    cacheAnimeList(data);
    state.airingAll = data;
    render(dom.airingRow, data.slice(0, 6));
  } catch(e) {
    dom.airingRow.innerHTML = `<p style="color:var(--text-3);font-size:13px;padding:20px 0;">Failed to load. Try refreshing.</p>`;
  }
}

// ─── DYNAMIC HERO ────────────────────────────────────────
const HERO_INTERVAL = 7000; // ms per slide
const HERO_COUNT    = 8;    // how many top anime to cycle

const heroState = {
  items:    [],
  index:    0,
  layer:    'a',         // which img layer is active
  timer:    null,
  progress: null,
};

const heroEls = {
  textWrap:  $('hero-text'),
  rank:      $('hero-rank'),
  titleMain: $('hero-title-main'),
  titleAcc:  $('hero-title-accent'),
  score:     $('hero-score'),
  year:      $('hero-year'),
  eps:       $('hero-eps'),
  type:      $('hero-type'),
  synopsis:  $('hero-synopsis'),
  tags:      $('hero-tags'),
  wlBtn:     $('hero-wl-btn'),
  wlLabel:   $('hero-wl-label'),
  malBtn:    $('hero-mal-btn'),
  infoBtn:   $('hero-info-btn'),
  imgA:      $('hero-img-a'),
  imgB:      $('hero-img-b'),
  bgImg:     $('hero-bg-img'),
  glow:      $('hero-glow'),
  dots:      $('hero-dots'),
  fill:      $('hero-progress-fill'),
  prev:      $('hero-prev'),
  next:      $('hero-next'),
};

/** Split a title into [main, accent] parts */
function splitTitle(title) {
  // Prefer colon split (e.g. "Attack on Titan: Final Season" → ["Attack on Titan:", "Final Season"])
  const colon = title.lastIndexOf(':');
  if (colon > 4 && colon < title.length - 2) {
    return [title.slice(0, colon + 1), title.slice(colon + 1).trim()];
  }
  // Dash split
  const dash = title.lastIndexOf(' - ');
  if (dash > 4) {
    return [title.slice(0, dash), title.slice(dash + 3)];
  }
  // Long title: split around 55% mark at a space
  if (title.length > 16) {
    const mid = Math.floor(title.length * 0.55);
    const sp  = title.lastIndexOf(' ', mid);
    if (sp > 4) return [title.slice(0, sp), title.slice(sp + 1)];
  }
  return [title, ''];
}

/** Populate hero with anime data (no transition) */
function populateHero(anime, idx) {
  const [main, accent] = splitTitle(anime.title || '');
  heroEls.rank.textContent    = `#${anime.rank || idx + 1} in Top Rated`;
  heroEls.titleMain.textContent = main;
  heroEls.titleAcc.textContent  = accent;
  heroEls.score.textContent   = `★ ${anime.score ?? '—'}`;
  heroEls.year.textContent    = anime.year ?? '—';
  heroEls.eps.textContent     = anime.episodes ? `${anime.episodes} eps` : '? eps';
  heroEls.type.textContent    = anime.type ?? 'TV';
  heroEls.synopsis.textContent = (anime.synopsis || 'No description available.')
    .replace(/\[Written by.*?\]/i, '').trim();

  // Tags
  heroEls.tags.innerHTML = '';
  (anime.genres || []).slice(0, 4).forEach(g => {
    const s = document.createElement('span');
    s.className = 'genre-tag';
    s.textContent = g.name;
    heroEls.tags.appendChild(s);
  });

  // Watchlist btn
  heroEls.wlBtn.dataset.id = anime.mal_id;
  const inWl = isInWatchlist(anime.mal_id);
  heroEls.wlBtn.classList.toggle('in-wl', inWl);
  heroEls.wlLabel.textContent = inWl ? 'In Watchlist' : 'Add to Watchlist';

  // MAL link
  heroEls.malBtn.href = anime.url || '#';
}

/** Swap poster images with crossfade */
function swapPoster(url) {
  const incoming = heroState.layer === 'a' ? heroEls.imgB : heroEls.imgA;
  const outgoing = heroState.layer === 'a' ? heroEls.imgA : heroEls.imgB;

  incoming.src = url;
  incoming.onload = () => {
    incoming.classList.add('active');
    outgoing.classList.remove('active');
    heroState.layer = heroState.layer === 'a' ? 'b' : 'a';
  };

  // BG blur image
  heroEls.bgImg.src = url;
  heroEls.bgImg.onload = () => heroEls.bgImg.classList.add('loaded');
}

/** Animate text out → update → text in */
function transitionHero(anime, idx) {
  const wrap = heroEls.textWrap;
  wrap.classList.remove('entering');
  wrap.classList.add('transitioning');

  setTimeout(() => {
    populateHero(anime, idx);
    swapPoster(anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || '');
    wrap.classList.remove('transitioning');
    wrap.classList.add('entering');
    updateDots(idx);
    startProgress();
  }, 280);
}

/** Go to a specific slide index */
function goToSlide(newIdx, animate = true) {
  if (!heroState.items.length) return;
  newIdx = ((newIdx % heroState.items.length) + heroState.items.length) % heroState.items.length;
  heroState.index = newIdx;
  const anime = heroState.items[newIdx];
  if (animate) {
    transitionHero(anime, newIdx);
  } else {
    populateHero(anime, newIdx);
    swapPoster(anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || '');
    updateDots(newIdx);
    startProgress();
  }
}

/** Build dot buttons */
function buildDots(count) {
  heroEls.dots.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const d = document.createElement('button');
    d.className = 'hero-dot' + (i === 0 ? ' active' : '');
    d.dataset.index = i;
    d.setAttribute('aria-label', `Go to slide ${i + 1}`);
    d.addEventListener('click', () => {
      stopAuto();
      goToSlide(+d.dataset.index);
      startAuto();
    });
    heroEls.dots.appendChild(d);
  }
}

function updateDots(idx) {
  heroEls.dots.querySelectorAll('.hero-dot').forEach((d, i) => {
    d.classList.toggle('active', i === idx);
  });
}

/** Progress bar */
function startProgress() {
  const fill = heroEls.fill;
  fill.classList.remove('animating');
  fill.style.width = '0%';
  // Force reflow
  void fill.offsetWidth;
  fill.classList.add('animating');
  fill.style.transition = `width ${HERO_INTERVAL}ms linear`;
  fill.style.width = '100%';
}

/** Auto-rotate */
function startAuto() {
  stopAuto();
  heroState.timer = setInterval(() => {
    goToSlide(heroState.index + 1);
  }, HERO_INTERVAL);
}
function stopAuto() {
  clearInterval(heroState.timer);
  heroState.timer = null;
}

/** Pause on hover */
const heroSection = document.getElementById('hero');
heroSection.addEventListener('mouseenter', stopAuto);
heroSection.addEventListener('mouseleave', startAuto);

/** Prev / Next */
heroEls.prev.addEventListener('click', () => {
  stopAuto();
  goToSlide(heroState.index - 1);
  startAuto();
});
heroEls.next.addEventListener('click', () => {
  stopAuto();
  goToSlide(heroState.index + 1);
  startAuto();
});

/** Info button → open modal */
heroEls.infoBtn.addEventListener('click', () => {
  const anime = heroState.items[heroState.index];
  if (anime) openModal(anime);
});

/** Watchlist button on hero */
heroEls.wlBtn.addEventListener('click', () => {
  const anime = heroState.items[heroState.index];
  if (anime) {
    toggleWatchlist(anime);
    const inWl = isInWatchlist(anime.mal_id);
    heroEls.wlBtn.classList.toggle('in-wl', inWl);
    heroEls.wlLabel.textContent = inWl ? 'In Watchlist' : 'Add to Watchlist';
  }
});

/** Touch/swipe support */
let touchStartX = 0;
heroSection.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
heroSection.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 50) {
    stopAuto();
    goToSlide(dx < 0 ? heroState.index + 1 : heroState.index - 1);
    startAuto();
  }
}, { passive: true });

/** Called once top anime data is ready */
function initHero(animeList) {
  heroState.items = animeList.slice(0, HERO_COUNT);
  buildDots(heroState.items.length);
  goToSlide(0, false);  // first slide, no transition
  startAuto();
}

// ─── ARROW BUTTONS (expand/collapse) ─────────────────────
document.querySelectorAll('.row-arrow').forEach(btn => {
  btn.addEventListener('click', () => handleExpand(btn));
});

async function handleExpand(btn) {
  const rowId   = btn.dataset.row;           // 'top-rated' | 'airing'
  const isExp   = btn.dataset.expanded === 'true';
  const grid    = $(`${rowId}-grid`);
  const moreWrap= $(`${rowId}-more`);
  const compRow = $(`${rowId}-row`);

  if (isExp) {
    // Collapse back
    btn.dataset.expanded = 'false';
    btn.classList.remove('expanded');
    btn.querySelector('.row-arrow-label').textContent = 'See all';

    grid.style.display   = 'none';
    moreWrap.style.display = 'none';
    compRow.style.display  = '';
  } else {
    // Expand
    btn.dataset.expanded = 'true';
    btn.classList.add('expanded');
    btn.querySelector('.row-arrow-label').textContent = 'Collapse';

    compRow.style.display  = 'none';
    grid.style.display     = 'grid';

    const allItems = rowId === 'top-rated' ? state.topAll : state.airingAll;

    if (allItems.length) {
      render(grid, allItems);
    } else {
      showSkeleton(grid, 12);
      await loadMoreRows(rowId, 1, grid);
    }

    moreWrap.style.display = 'block';
  }
}

async function loadMoreRows(rowId, page, grid) {
  const endpoint = rowId === 'top-rated'
    ? `/top/anime?limit=25&page=${page}`
    : `/seasons/now?limit=25&page=${page}`;
  try {
    const { data } = await apiFetch(endpoint);
    cacheAnimeList(data);
    if (page === 1) render(grid, data);
    else appendCards(grid, data);
    return data.length;
  } catch(e) {
    return 0;
  }
}

// Load more button
document.querySelectorAll('.load-more-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const rowId = btn.dataset.row;
    const page  = parseInt(btn.dataset.page) + 1;
    const grid  = $(`${rowId}-grid`);
    btn.textContent = 'Loading…';
    btn.disabled = true;
    const count = await loadMoreRows(rowId, page, grid);
    btn.dataset.page = page;
    btn.disabled = false;
    btn.textContent = count < 5 ? 'No more results' : 'Load more';
    if (count < 5) btn.disabled = true;
  });
});

// ─── SEARCH ──────────────────────────────────────────────
async function searchAnime(query) {
  query = query.trim();
  if (!query) {
    showDefaultView();
    return;
  }
  showSkeleton(dom.resultsGrid, 12);
  showResultsView(`Results for "${query}"`);
  try {
    const { data } = await apiFetch(`/anime?q=${encodeURIComponent(query)}&limit=20&sfw=true`);
    cacheAnimeList(data);
    displayResults(data);
  } catch(e) {
    displayResults([]);
  }
}

// ─── FILTER ──────────────────────────────────────────────
async function runFilters() {
  const genre  = dom.filterGenre.value;
  const status = dom.filterStatus.value;
  const sort   = dom.filterSort.value;
  const score  = parseFloat(dom.filterScore.value);

  showSkeleton(dom.resultsGrid, 12);
  showResultsView('Filtered Results');

  let endpoint = '/anime?limit=25&sfw=true';
  if (genre !== 'all')   endpoint += `&genres=${genre}`;
  if (status !== 'all')  endpoint += `&status=${status}`;
  endpoint += `&order_by=${sort}&sort=desc`;

  try {
    const { data } = await apiFetch(endpoint);
    cacheAnimeList(data);
    let filtered = score > 0
      ? data.filter(a => a.score && a.score >= score)
      : data;
    displayResults(filtered);
  } catch(e) {
    displayResults([]);
  }
}

// ─── RESET FILTERS ───────────────────────────────────────
function resetFilters() {
  dom.filterGenre.value  = 'all';
  dom.filterStatus.value = 'all';
  dom.filterSort.value   = 'score';
  dom.filterScore.value  = 0;
  dom.filterSearch.value = '';
  dom.scoreDisplay.textContent = 'Any';
  showDefaultView();
}
window.resetFilters = resetFilters; // expose globally for onclick

// ─── VIEW HELPERS ────────────────────────────────────────
function showDefaultView() {
  dom.defaultView.style.display     = 'block';
  dom.resultsSection.style.display  = 'none';
}

function showResultsView(title) {
  dom.defaultView.style.display     = 'none';
  dom.resultsSection.style.display  = 'block';
  $('results-title').textContent    = title;
  dom.emptyState.style.display      = 'none';
}

function displayResults(list) {
  if (!list.length) {
    dom.emptyState.style.display  = 'block';
    dom.resultsGrid.innerHTML     = '';
  } else {
    dom.emptyState.style.display  = 'none';
    render(dom.resultsGrid, list);
  }
}

// ─── WATCHLIST ───────────────────────────────────────────
function toggleWatchlist(anime) {
  const idx = state.watchlist.findIndex(a => a.mal_id === anime.mal_id);
  if (idx === -1) {
    state.watchlist.push(anime);
    showToast('✓ Added to Watchlist');
  } else {
    state.watchlist.splice(idx, 1);
    showToast('Removed from Watchlist');
  }
  saveWatchlist();
  updateBadge();
  refreshHearts(anime.mal_id);
  renderWatchlistPanel();
}

function refreshHearts(id) {
  const inWl = isInWatchlist(id);
  document.querySelectorAll(`.card-heart[data-id="${id}"]`).forEach(el => {
    el.classList.toggle('active', inWl);
    el.textContent = inWl ? '❤' : '♡';
  });
  // Sync hero btn if it's showing this anime
  const currentHero = heroState.items[heroState.index];
  if (currentHero?.mal_id === id && heroEls.wlBtn) {
    heroEls.wlBtn.classList.toggle('in-wl', inWl);
    heroEls.wlLabel.textContent = inWl ? 'In Watchlist' : 'Add to Watchlist';
  }
  // Sync modal btn
  if (state.currentAnime?.mal_id === id) {
    const inWl2 = isInWatchlist(id);
    $('modal-wl-btn').classList.toggle('in-list', inWl2);
    $('modal-wl-label').textContent = inWl2 ? 'In Watchlist' : 'Add to Watchlist';
  }
}

// ─── WATCHLIST PANEL ─────────────────────────────────────
function openWatchlistPanel() {
  dom.wlPanel.classList.add('open');
  dom.wlOverlay.classList.add('open');
  renderWatchlistPanel();
}
function closeWatchlistPanel() {
  dom.wlPanel.classList.remove('open');
  dom.wlOverlay.classList.remove('open');
}
function renderWatchlistPanel() {
  if (!state.watchlist.length) {
    dom.wlList.innerHTML = `
      <div class="wl-empty">
        <div class="empty-face">( ˘･з･)</div>
        <p>Nothing here yet.<br>Add anime you want to watch!</p>
      </div>`;
    return;
  }
  dom.wlList.innerHTML = '';
  state.watchlist.forEach(anime => {
    const item = document.createElement('div');
    item.className = 'wl-item';
    item.innerHTML = `
      <img class="wl-item-img" src="${anime.images?.jpg?.image_url || ''}" alt="" loading="lazy" />
      <div class="wl-item-info">
        <div class="wl-item-title">${escHtml(anime.title)}</div>
        <div class="wl-item-meta">${anime.year || '—'} · ${anime.episodes || '?'} eps</div>
      </div>
      <span class="wl-item-score">★ ${anime.score || '—'}</span>
      <button class="wl-remove" data-id="${anime.mal_id}" title="Remove">✕</button>
    `;
    item.querySelector('.wl-item-info').addEventListener('click', () => {
      openModal(anime);
      closeWatchlistPanel();
    });
    item.querySelector('.wl-item-img').addEventListener('click', () => {
      openModal(anime);
      closeWatchlistPanel();
    });
    item.querySelector('.wl-remove').addEventListener('click', e => {
      e.stopPropagation();
      toggleWatchlist(anime);
    });
    dom.wlList.appendChild(item);
  });
}

// ─── MODAL ───────────────────────────────────────────────
function openModal(anime) {
  state.currentAnime = anime;

  $('modal-title').textContent  = anime.title;
  $('modal-title-en').textContent = anime.title_english && anime.title_english !== anime.title
    ? anime.title_english : '';
  $('modal-poster').src         = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || '';
  $('modal-synopsis').textContent = anime.synopsis
    ? anime.synopsis.replace(/\[Written by.*?\]/i, '').trim()
    : 'No description available.';
  $('modal-score-box').textContent = anime.score || '—';

  // Status badge
  const badge   = $('modal-status');
  const statusRaw = (anime.status || '').toLowerCase();
  badge.textContent = anime.status || '—';
  badge.className = 'status-badge';
  if (statusRaw.includes('currently') || statusRaw.includes('airing')) {
    // default green
  } else if (statusRaw.includes('finished') || statusRaw.includes('complete')) {
    badge.classList.add('finished');
  } else if (statusRaw.includes('upcoming') || statusRaw.includes('not yet')) {
    badge.classList.add('upcoming');
  }

  $('modal-meta').textContent = [
    anime.type,
    anime.year ? anime.year : null
  ].filter(Boolean).join(' · ');

  // Genres
  const genreWrap = $('modal-genres');
  genreWrap.innerHTML = '';
  (anime.genres || []).slice(0, 6).forEach(g => {
    const t = document.createElement('span');
    t.className = 'modal-genre-tag';
    t.textContent = g.name;
    genreWrap.appendChild(t);
  });

  // Stats
  $('ms-score').textContent = anime.score || '—';
  $('ms-rank').textContent  = anime.rank  ? `#${anime.rank}` : '—';
  $('ms-eps').textContent   = anime.episodes || '?';
  $('ms-year').textContent  = anime.year || '—';

  $('modal-mal').href = anime.url || '#';

  const wlBtn = $('modal-wl-btn');
  const inWl  = isInWatchlist(anime.mal_id);
  wlBtn.classList.toggle('in-list', inWl);
  $('modal-wl-label').textContent = inWl ? 'In Watchlist' : 'Add to Watchlist';

  dom.modalOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  dom.modalOverlay.classList.remove('open');
  document.body.style.overflow = '';
}

// ─── EVENTS ──────────────────────────────────────────────

// Card hearts (delegated)
document.addEventListener('click', e => {
  const heart = e.target.closest('.card-heart');
  if (heart) {
    e.stopPropagation();
    const id = +heart.dataset.id;
    const anime = animeMap.get(id);
    if (anime) toggleWatchlist(anime);
  }
});

// Modal
dom.modalClose.onclick = closeModal;
dom.modalOverlay.onclick = e => {
  if (e.target === dom.modalOverlay) closeModal();
};
$('modal-wl-btn').onclick = () => {
  if (state.currentAnime) toggleWatchlist(state.currentAnime);
};

// Hero watchlist and info buttons are handled inside initHero/heroEls block above

// Watchlist panel
$('nav-watchlist-link').addEventListener('click', e => {
  e.preventDefault();
  openWatchlistPanel();
});
dom.wlClose.onclick  = closeWatchlistPanel;
dom.wlOverlay.onclick = closeWatchlistPanel;

// Search toggle (nav)
dom.searchToggle.onclick = () => {
  dom.searchDropdown.classList.toggle('open');
  if (dom.searchDropdown.classList.contains('open'))
    dom.searchInput.focus();
};
dom.searchClear.onclick = () => {
  dom.searchInput.value = '';
  showDefaultView();
};

// Search inputs (debounced)
dom.searchInput.addEventListener('input', debounce(e => searchAnime(e.target.value), 600));
dom.filterSearch.addEventListener('input', debounce(e => searchAnime(e.target.value), 600));

// Sync search inputs
dom.searchInput.addEventListener('input', e => { dom.filterSearch.value = e.target.value; });
dom.filterSearch.addEventListener('input', e => { dom.searchInput.value = e.target.value; });

// Filter controls
$('filter-btn').onclick   = runFilters;
$('filter-reset').onclick = resetFilters;
$('clear-results-btn').onclick = resetFilters;
$('empty-reset-btn').onclick   = resetFilters;

// Score display
dom.filterScore.oninput = () => {
  const v = dom.filterScore.value;
  dom.scoreDisplay.textContent = v == 0 ? 'Any' : `${v}+`;
};

// Close search dropdown on outside click
document.addEventListener('click', e => {
  if (!dom.searchDropdown.contains(e.target) && e.target !== dom.searchToggle) {
    dom.searchDropdown.classList.remove('open');
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal();
    closeWatchlistPanel();
    dom.searchDropdown.classList.remove('open');
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    dom.searchDropdown.classList.add('open');
    dom.searchInput.focus();
  }
});

// ─── DEBOUNCE ────────────────────────────────────────────
function debounce(fn, delay = 400) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

// ─── INIT ────────────────────────────────────────────────
async function init() {
  updateBadge();
  renderWatchlistPanel();

  await loadTop();    // also calls initHero()
  await loadAiring();
}

init();
