// Teachers database - loaded from external JSON
let TEACHERS_DB = [];

const URL_PARAMS = new URLSearchParams(window.location.search);
const DEBUG_AUDIO = URL_PARAMS.has('debugAudio');
const DISABLE_HIDDEN_EPISODES_STORAGE = URL_PARAMS.has('debugNoHideStorage');

// Slugify teacher name for vanity URL
function slugifyName(name) {
    return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '');
}

// Copy vanity URL to clipboard
function copyVanityUrl(slug) {
    const url = `https://dharma.talk/${slug}`;
    navigator.clipboard.writeText(url).then(() => {
        const btn = document.querySelector('.vanity-url-btn');
        if (btn) {
            btn.classList.add('copied');
            const textEl = btn.querySelector('.vanity-url-text');
            const originalText = textEl.textContent;
            textEl.textContent = 'Copied!';
            setTimeout(() => {
                btn.classList.remove('copied');
                textEl.textContent = originalText;
            }, 1500);
        }
    });
}

// Platform detection (used only for performance workarounds)
const IS_IOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
const IS_IOS_CHROME = IS_IOS && /CriOS\//.test(navigator.userAgent);

let audio = document.getElementById('audio');
// Make sure inline handlers and devtools can reference the current element.
window.audio = audio;

// Normalize initial audio element
if (audio) {
    audio.preload = 'none';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
}

// Audio element replacement bookkeeping (helps iOS Chrome stop piling up work)
let audioInstanceId = 0;
let audioHandlersBoundTo = null;
const audioDebug = (window.__dharmaseedAudioDebug ||= {
    resets: 0,
    plays: 0,
    lastSrc: null,
    events: []
});
const player = document.getElementById('player');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const playerTitle = document.getElementById('playerTitle');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');
const progressFill = document.getElementById('progressFill');
const progressBar = document.getElementById('progressBar');

const speedBtn = document.getElementById('speedBtn');
const searchInput = document.getElementById('searchInput');

// Handle image loading errors
function handleImageError(img, initials) {
    const placeholder = document.createElement('div');
    placeholder.className = 'photo-placeholder';
    placeholder.textContent = initials;
    img.parentNode.replaceChild(placeholder, img);
}

let episodes = [];
let currentEpisode = null;
const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];
let speedIndex = 1;

// Playback state persistence
const PLAYBACK_STORAGE_KEY = 'dharmaseed_playback';
const EPISODE_PROGRESS_KEY = 'dharmaseed_episode_progress';
const HIDDEN_EPISODES_KEY = 'dharmaseed_hidden_episodes';
let savePlaybackInterval = null;

// Hidden episodes tracking
function getHiddenEpisodes() {
    if (DISABLE_HIDDEN_EPISODES_STORAGE) return [];
    try {
        const data = localStorage.getItem(HIDDEN_EPISODES_KEY);
        return data ? JSON.parse(data) : [];
    } catch {
        return [];
    }
}

function hideEpisode(talkId) {
    if (DISABLE_HIDDEN_EPISODES_STORAGE) return;
    const hidden = getHiddenEpisodes();
    if (!hidden.includes(talkId)) {
        hidden.push(talkId);
        localStorage.setItem(HIDDEN_EPISODES_KEY, JSON.stringify(hidden));
    }
}

function unhideEpisode(talkId) {
    if (DISABLE_HIDDEN_EPISODES_STORAGE) return;
    const hidden = getHiddenEpisodes();
    const filtered = hidden.filter(id => id !== talkId);
    localStorage.setItem(HIDDEN_EPISODES_KEY, JSON.stringify(filtered));
}

function isEpisodeHidden(talkId) {
    return getHiddenEpisodes().includes(talkId);
}

// Episode progress tracking
function getEpisodeProgress() {
    try {
        const data = localStorage.getItem(EPISODE_PROGRESS_KEY);
        return data ? JSON.parse(data) : {};
    } catch {
        return {};
    }
}

function saveEpisodeProgress(talkId, percent, position, duration) {
    if (!talkId || !duration) return;
    const progress = getEpisodeProgress();
    progress[talkId] = {
        percent: Math.round(percent),
        position: position,
        duration: duration,
        timestamp: Date.now()
    };
    // Keep only last 500 episodes to prevent localStorage bloat
    const entries = Object.entries(progress);
    if (entries.length > 500) {
        entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
        const trimmed = Object.fromEntries(entries.slice(0, 500));
        localStorage.setItem(EPISODE_PROGRESS_KEY, JSON.stringify(trimmed));
    } else {
        localStorage.setItem(EPISODE_PROGRESS_KEY, JSON.stringify(progress));
    }
}

function getEpisodeProgressPercent(talkId) {
    const progress = getEpisodeProgress();
    return progress[talkId]?.percent || 0;
}

function savePlaybackState() {
    if (!currentEpisode || !currentTeacherId) return;
    const state = {
        teacherId: currentTeacherId,
        talkId: currentEpisode.id,
        talkTitle: currentEpisode.title,
        teacherName: window.currentTeacherInfo?.name || '',
        position: audio.currentTime,
        duration: audio.duration || 0,
        timestamp: Date.now()
    };
    localStorage.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify(state));
    
    // Also save episode progress
    if (audio.duration > 0) {
        const percent = (audio.currentTime / audio.duration) * 100;
        saveEpisodeProgress(currentEpisode.id, percent, audio.currentTime, audio.duration);
    }
}

function clearPlaybackState() {
    localStorage.removeItem(PLAYBACK_STORAGE_KEY);
}

function getPlaybackState() {
    try {
        const data = localStorage.getItem(PLAYBACK_STORAGE_KEY);
        return data ? JSON.parse(data) : null;
    } catch {
        return null;
    }
}

function startPlaybackSaveInterval() {
    if (savePlaybackInterval) clearInterval(savePlaybackInterval);
    savePlaybackInterval = setInterval(savePlaybackState, 15000);
}

function stopPlaybackSaveInterval() {
    if (savePlaybackInterval) {
        clearInterval(savePlaybackInterval);
        savePlaybackInterval = null;
    }
}

// No external CORS proxy needed - use local server.py or Netlify redirects
const INITIAL_BATCH_SIZE = 30;

// State
let currentTeacherId = null;
let totalTalksAvailable = 0;
let isLoadingAllTalks = false;
let episodeSearchQuery = '';
let teacherSearchQuery = '';
let recentFilterActive = false;

// Teachers infinite scroll state
let teachersDisplayed = 0;
const TEACHERS_BATCH_SIZE = 25;
let isLoadingMoreTeachers = false;
let sortedTeachers = [];

// Render popular teachers grid (with infinite scroll support)
function renderPopularTeachers(append = false) {
    if (!append) {
        // Initial load - sort by talk count (default) or by most recent if filter active
        // Always hide teachers with 0 talks
        let filteredTeachers = [...TEACHERS_DB].filter(t => t.talk_count > 0);
        
        // Apply recent filter (within last month)
        if (recentFilterActive) {
            const oneMonthAgo = new Date();
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
            const cutoffDate = oneMonthAgo.toISOString().slice(0, 10); // YYYY-MM-DD
            
            filteredTeachers = filteredTeachers.filter(t => 
                t.last_talk_date && t.last_talk_date >= cutoffDate
            );
            
            // Sort by most recent first when filter is active
            filteredTeachers.sort((a, b) => (b.last_talk_date || '').localeCompare(a.last_talk_date || ''));
        } else {
            // Default: sort by talk count
            filteredTeachers.sort((a, b) => b.talk_count - a.talk_count);
        }
        
        if (teacherSearchQuery.length >= 2) {
            const query = teacherSearchQuery.toLowerCase();
            filteredTeachers = filteredTeachers.filter(t => 
                t.name.toLowerCase().includes(query)
            );
        }
        
        sortedTeachers = filteredTeachers;
        teachersDisplayed = 0;
    }
    
    const startIndex = teachersDisplayed;
    const endIndex = Math.min(startIndex + TEACHERS_BATCH_SIZE, sortedTeachers.length);
    const teachersToRender = sortedTeachers.slice(startIndex, endIndex);
    
    const grid = document.getElementById('popularGrid');
    
    // Remove loading indicator if present
    const existingIndicator = document.getElementById('teachersLoadMoreIndicator');
    if (existingIndicator) existingIndicator.remove();
    
    const newCards = teachersToRender.map(t => {
        const initials = t.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        return `
            <div class="popular-card" onclick="selectTeacher(${t.id})">
                ${t.photo_url ? `<div class="bg-blur" style="background-image: url('${t.photo_url}')"></div>` : ''}
                <div class="photo-wrapper">
                    ${t.photo_url 
                        ? `<img src="${t.photo_url}" alt="${t.name}" class="photo" onerror="this.outerHTML='<div class=\\'photo-placeholder\\'>${initials}</div>'">`
                        : `<div class="photo-placeholder">${initials}</div>`
                    }
                </div>
                <div class="info">
                    <div class="name">${t.name}</div>
                    <div class="count">${t.talk_count} talks</div>
                </div>
            </div>
        `;
    }).join('');
    
    if (append) {
        grid.insertAdjacentHTML('beforeend', newCards);
    } else {
        grid.innerHTML = newCards;
    }
    
    teachersDisplayed = endIndex;
    
    // Add load more indicator if there are more teachers
    if (teachersDisplayed < sortedTeachers.length) {
        const indicator = document.createElement('div');
        indicator.id = 'teachersLoadMoreIndicator';
        indicator.className = 'load-more-indicator';
        indicator.innerHTML = '<div class="loading-spinner"></div><span>Loading more teachers...</span>';
        indicator.style.display = 'none';
        grid.parentElement.appendChild(indicator);
    }
}

// Search functionality - filter teachers list
searchInput.addEventListener('input', (e) => {
    const value = e.target.value;
    const prevLen = teacherSearchQuery.length;
    teacherSearchQuery = value.trim();
    const newLen = teacherSearchQuery.length;
    
    // Re-render when crossing the 2-char threshold or when already filtering
    if ((prevLen < 2 && newLen >= 2) || (prevLen >= 2 && newLen < 2) || (prevLen >= 2 && newLen >= 2)) {
        renderPopularTeachers(false);
        // Restore focus to search input
        searchInput.focus();
        searchInput.setSelectionRange(value.length, value.length);
    }
    
    // Show/hide clear button
    updateSearchIconState();
});

// Handle click on search/clear icon
function handleSearchIconClick() {
    if (teacherSearchQuery.length > 0) {
        clearTeacherSearch();
    } else {
        searchInput.focus();
    }
}

// Clear teacher search
function clearTeacherSearch() {
    teacherSearchQuery = '';
    searchInput.value = '';
    renderPopularTeachers(false);
    updateSearchIconState();
    searchInput.focus();
}

// Toggle recent filter (last month only)
function toggleRecentFilter() {
    recentFilterActive = !recentFilterActive;
    const btn = document.getElementById('recentFilterBtn');
    if (btn) {
        btn.classList.toggle('active', recentFilterActive);
    }
    renderPopularTeachers(false);
}

// Update search icon state (search vs clear)
function updateSearchIconState() {
    const iconBtn = document.getElementById('searchIconBtn');
    if (iconBtn) {
        iconBtn.classList.toggle('has-text', teacherSearchQuery.length > 0);
    }
}

// Keyboard navigation for teacher search
searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        clearTeacherSearch();
    }
});

async function selectTeacher(teacherId) {
    const teacher = TEACHERS_DB.find(t => t.id === teacherId);
    if (!teacher) return;

    document.getElementById('popularSection').style.display = 'none';
    document.querySelector('header').style.display = 'none';
    document.querySelector('.search-section').style.display = 'none';
    
    // Remove teachers infinite scroll when viewing a teacher
    removeTeachersInfiniteScroll();
    
    // Reset state
    currentTeacherId = teacherId;
    episodes = [];
    totalTalksAvailable = teacher.talk_count || 0;
    isLoadingAllTalks = false;
    episodeSearchQuery = '';
    
    // Update URL with teacher parameter
    updateUrl({ teacher: teacherId });
    
    // Show loading immediately in content area
    document.getElementById('content').innerHTML = `
        <div class="loading">
            <div class="loading-spinner"></div>
            <p>Loading talks...</p>
        </div>
    `;
    
    // Load first batch quickly for fast display (uses local proxy via server.py or Netlify)
    const feedUrl = `/feeds/teacher/${teacherId}/?max-entries=${INITIAL_BATCH_SIZE}`;
    await loadFeed(feedUrl, teacher, true);
    
    // Then load all talks in background
    loadAllTalksInBackground(teacherId, teacher);
}

// Background loading of all talks
async function loadAllTalksInBackground(teacherId, teacher) {
    if (isLoadingAllTalks || currentTeacherId !== teacherId) return;
    isLoadingAllTalks = true;
    
    try {
        const url = `/feeds/teacher/${teacherId}/?max-entries=all`;
        
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const text = await response.text();
        
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'text/xml');
        const channel = xml.querySelector('channel');
        if (!channel) throw new Error('Invalid XML');
        
        const items = xml.querySelectorAll('item');
        const allEpisodes = Array.from(items).map((item, index) => {
            const enclosure = item.querySelector('enclosure');
            const duration = item.querySelector('itunes\\:duration')?.textContent || '';
            const link = item.querySelector('link')?.textContent || '';
            const talkIdMatch = link.match(/\/talks\/(\d+)/);
            const talkId = talkIdMatch ? parseInt(talkIdMatch[1]) : index;
            
            return {
                id: talkId,
                index: index,
                title: item.querySelector('title')?.textContent || 'Untitled',
                description: item.querySelector('description')?.textContent || '',
                pubDate: item.querySelector('pubDate')?.textContent || '',
                audioUrl: enclosure?.getAttribute('url') || '',
                duration: duration,
                link: link
            };
        }).filter(ep => ep.audioUrl);
        
        // Only update if still on the same teacher
        if (currentTeacherId === teacherId) {
            episodes = allEpisodes;
            isLoadingAllTalks = false;
            renderEpisodes(true); // Skip animation on background update
            console.log(`Loaded all ${episodes.length} talks for teacher ${teacherId}`);
        } else {
            isLoadingAllTalks = false;
        }
    } catch (error) {
        console.log('Background loading failed, keeping initial batch:', error.message);
        isLoadingAllTalks = false;
        renderEpisodes(true); // Re-render to remove loading indicator, skip animation
    }
}

async function loadFeed(url, teacherInfo = null, isInitialLoad = true) {
    const content = document.getElementById('content');
    const teacherInfoEl = document.getElementById('teacherInfo');
    
    if (isInitialLoad) {
        content.innerHTML = `
            <div class="loading">
                <div class="loading-spinner"></div>
                <p>Loading talks...</p>
            </div>
        `;
    }

    try {
        console.log(`Fetching: ${url}`);
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const text = await response.text();
        
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'text/xml');
        
        // Check for parse errors
        const parseError = xml.querySelector('parsererror');
        const channel = xml.querySelector('channel');
        
        if (parseError || !channel) {
            throw new Error('Invalid XML format');
        }
        
        const title = channel.querySelector('title')?.textContent || teacherInfo?.name || 'Unknown Teacher';
        const description = channel.querySelector('description')?.textContent || '';
        const imageEl = channel.querySelector('image url') || channel.querySelector('itunes\\:image');
        const image = imageEl?.textContent || imageEl?.getAttribute('href') || '';
        
        const items = xml.querySelectorAll('item');
        const newEpisodes = Array.from(items).map((item, index) => {
            const enclosure = item.querySelector('enclosure');
            const duration = item.querySelector('itunes\\:duration')?.textContent || '';
            const link = item.querySelector('link')?.textContent || '';
            
            // Extract real Dharmaseed talk ID from link (e.g., https://dharmaseed.org/talks/94385/)
            const talkIdMatch = link.match(/\/talks\/(\d+)/);
            const talkId = talkIdMatch ? parseInt(talkIdMatch[1]) : index;
            
            return {
                id: talkId,
                index: index,
                title: item.querySelector('title')?.textContent || 'Untitled',
                description: item.querySelector('description')?.textContent || '',
                pubDate: item.querySelector('pubDate')?.textContent || '',
                audioUrl: enclosure?.getAttribute('url') || '',
                duration: duration,
                link: link
            };
        }).filter(ep => ep.audioUrl);
        
        // Store all episodes
        episodes = newEpisodes;
        const startIndex = 0;

        // Use teacher name from our database (cleaner than RSS title)
        const teacherName = teacherInfo?.name || title;
        const initial = teacherName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        
        // Prefer photo_url from our DB, fallback to feed image
        const photoUrl = teacherInfo?.photo_url || image;

        // Store current teacher info for player
        window.currentTeacherInfo = { name: teacherName, photo: photoUrl };

        // Change body background to teacher photo
        if (photoUrl) {
            document.body.style.setProperty('--bg-image', `url('${photoUrl}')`);
        }

        // Only render teacher header on initial load
        if (isInitialLoad) {
            teacherInfoEl.innerHTML = `
            <div class="teacher-hero">
                <div class="teacher-hero-bg" style="background-image: url('${photoUrl}')"></div>
                <div class="teacher-hero-overlay"></div>
                <div class="teacher-hero-content">
                    <button class="back-btn" onclick="goHome()">
                        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M15 18l-6-6 6-6"/>
                        </svg>
                    </button>
                    ${photoUrl 
                        ? `<img src="${photoUrl}" alt="${teacherName}" class="teacher-photo-large" onerror="this.outerHTML='<div class=\\'teacher-photo-placeholder-large\\'>${initial}</div>'">`
                        : `<div class="teacher-photo-placeholder-large">${initial}</div>`
                    }
                    <div class="teacher-hero-info">
                        <h2 class="teacher-hero-name">${teacherName}</h2>
                        <div class="teacher-hero-actions">
                            ${teacherInfo?.donation_url 
                                ? `<a href="${teacherInfo.donation_url}" target="_blank" rel="noopener noreferrer" class="donation-btn">❤️ Donate</a>`
                                : ''
                            }
                            <span class="teacher-hero-stats">${teacherInfo?.talk_count || episodes.length} talks</span>
                            <button class="vanity-url-btn" onclick="copyVanityUrl('${slugifyName(teacherName)}')" title="Copy link">
                                <span class="vanity-url-text">dharma.talk/${slugifyName(teacherName)}</span>
                            </button>
                        </div>
                        ${description ? `<p class="teacher-hero-description">${description}</p>` : ''}
                    </div>
                </div>
            </div>
        `;
        }

        renderEpisodes();

    } catch (error) {
        console.error(`Load error:`, error.message);
        
        const teacherName = teacherInfo?.name || 'this teacher';
        content.innerHTML = `
            <div class="loading">
                <p>Could not load talks for ${teacherName}.</p>
                <p style="font-size: 0.85rem; margin-top: 0.5rem; color: var(--text-muted);">${error.message}</p>
                <button onclick="retryLoad(${teacherInfo?.id})" style="margin-top: 1rem; padding: 0.5rem 1rem; background: var(--accent); color: white; border: none; border-radius: 6px; cursor: pointer; font-family: inherit;">
                    Retry
                </button>
                <button onclick="goHome()" style="margin-top: 1rem; margin-left: 0.5rem; padding: 0.5rem 1rem; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-family: inherit;">
                    Back to teachers
                </button>
            </div>
        `;
    }
}

function retryLoad(teacherId) {
    if (teacherId) {
        selectTeacher(teacherId);
    }
}

function goHome() {
    // Stop and hide the player
    stopPlaybackSaveInterval();
    if (IS_IOS_CHROME) {
        replaceAudioElement();
    } else {
        hardStopAudio();
    }
    document.querySelector('.player').classList.remove('visible');
    currentEpisode = null;
    updatePlayButton(false);
    
    document.getElementById('teacherInfo').innerHTML = '';
    document.getElementById('content').innerHTML = '';
    document.getElementById('popularSection').style.display = 'block';
    document.querySelector('header').style.display = '';
    document.querySelector('.search-section').style.display = '';
    window.currentTeacherInfo = null;
    // Restore default background
    document.body.style.removeProperty('--bg-image');
    
    // Reset state
    currentTeacherId = null;
    episodes = [];
    
    // Clear URL parameters
    updateUrl({});
    
    // Scroll to top before restoring infinite scroll to avoid triggering it
    window.scrollTo(0, 0);
    
    // Restore teachers infinite scroll
    setupTeachersInfiniteScroll();
}

function updateUrl(params) {
    const url = new URL(window.location.href);
    url.search = '';
    if (params.teacher) url.searchParams.set('teacher', params.teacher);
    if (params.talk) url.searchParams.set('talk', params.talk);
    window.history.replaceState({}, '', url);
}

function truncate(str, length) {
    if (!str) return '';
    return str.length > length ? str.substring(0, length) + '...' : str;
}

// Strip teacher name prefix from title (format: "Teacher Name: Talk Title")
function stripTeacherPrefix(title) {
    if (!title) return '';
    const colonIndex = title.indexOf(':');
    if (colonIndex > 0 && colonIndex < title.length - 1) {
        return title.substring(colonIndex + 1).trim();
    }
    return title;
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });
    } catch {
        return dateStr;
    }
}

function formatDuration(duration) {
    if (!duration) return '';
    const parts = duration.split(':').map(Number);
    if (parts.length === 3) {
        const [h, m] = parts;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    } else if (parts.length === 2) {
        return `${parts[0]}m`;
    }
    return duration;
}

function renderEpisodes(skipAnimation = false) {
    const content = document.getElementById('content');
    
    // Keep showing loader if no episodes yet and still loading
    if (episodes.length === 0 && isLoadingAllTalks) {
        content.innerHTML = `
            <div class="loading">
                <div class="loading-spinner"></div>
                <p>Loading talks...</p>
            </div>
        `;
        return;
    }
    
    // Show loading indicator if still loading more talks
    const loadingMore = isLoadingAllTalks && episodes.length < totalTalksAvailable;
    
    // Get hidden episodes
    const hiddenEpisodes = getHiddenEpisodes();
    
    // Filter episodes by search query (only filter after 3+ characters) and exclude hidden
    const query = episodeSearchQuery.toLowerCase().trim();
    let filteredEpisodes = episodes.filter(ep => !hiddenEpisodes.includes(ep.id));
    if (query.length >= 3) {
        filteredEpisodes = filteredEpisodes.filter(ep => stripTeacherPrefix(ep.title).toLowerCase().includes(query));
    }
    
    content.innerHTML = `
        <div class="playlist-search">
            <div class="playlist-search-wrapper">
                <button type="button" class="playlist-search-icon-btn ${episodeSearchQuery ? 'has-text' : ''}" onclick="handleEpisodeSearchIconClick()">
                    <svg class="icon-search" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/>
                        <path d="M21 21l-4.35-4.35"/>
                    </svg>
                    <svg class="icon-clear" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </button>
                <input type="text" 
                       class="playlist-search-input" 
                       placeholder="Search talks..." 
                       value="${episodeSearchQuery}"
                       oninput="handleEpisodeSearch(this.value)">
            </div>
        </div>
        ${filteredEpisodes.length === 0 && query ? `
            <div class="no-results">
                <p>No talks found for "${episodeSearchQuery}"</p>
            </div>
        ` : `
            <div class="episodes">
                ${filteredEpisodes.map((ep, i) => {
                    const originalIndex = episodes.indexOf(ep);
                    return `
                    <div class="episode ${currentEpisode?.id === ep.id ? 'playing' : ''}" 
                         data-id="${ep.id}"
                         onclick="playEpisode(${ep.id})"
                         style="${skipAnimation ? 'animation: none;' : `animation-delay: ${Math.min(i * 0.03, 0.3)}s`}">
                        <div class="episode-number">${originalIndex + 1}</div>
                        <div class="episode-play-icon">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="5,3 19,12 5,21"/>
                            </svg>
                        </div>
                        <div class="episode-main">
                            <div class="episode-title">${stripTeacherPrefix(ep.title)}</div>
                            <div class="episode-meta">
                                <span>${formatDate(ep.pubDate)}</span>
                            </div>
                        </div>
                        <div class="episode-right">
                            <div class="episode-duration">${formatDuration(ep.duration)}</div>
                            ${(() => {
                                const pct = getEpisodeProgressPercent(ep.id);
                                if (pct <= 0) return '';
                                return `<span class="episode-progress" data-talk-id="${ep.id}">${pct >= 95 ? '100' : pct}%</span>`;
                            })()}
                        </div>
                    </div>
                `}).join('')}
            </div>
            ${loadingMore ? `
                <div class="load-more-indicator" id="loadMoreIndicator">
                    <div class="loading-spinner-small"></div>
                    <span>Loading ${totalTalksAvailable - episodes.length} more talks...</span>
                </div>
            ` : `
                <div class="end-of-list">
                    <span>${query ? `${filteredEpisodes.length} of ${episodes.length} talks` : `All ${episodes.length} talks loaded`}</span>
                </div>
            `}
        `}
    `;
    
        // Swipe-to-hide disabled for now (iOS Chrome perf).
}

function handleEpisodeSearch(value) {
    const prevQuery = episodeSearchQuery;
    episodeSearchQuery = value;
    
    // Only re-render if we cross the 3-character threshold or if already filtering
    const prevLen = prevQuery.trim().length;
    const newLen = value.trim().length;
    
    if ((prevLen < 3 && newLen >= 3) || (prevLen >= 3 && newLen < 3) || (prevLen >= 3 && newLen >= 3)) {
        renderEpisodes(true);
        // Restore focus to search input
        const searchInput = document.querySelector('.playlist-search-input');
        if (searchInput) {
            searchInput.focus();
            searchInput.setSelectionRange(value.length, value.length);
        }
    }
    
    // Update icon state
    const iconBtn = document.querySelector('.playlist-search-icon-btn');
    if (iconBtn) {
        iconBtn.classList.toggle('has-text', value.length > 0);
    }
}

function handleEpisodeSearchIconClick() {
    if (episodeSearchQuery.length > 0) {
        clearEpisodeSearch();
    } else {
        const searchInput = document.querySelector('.playlist-search-input');
        if (searchInput) searchInput.focus();
    }
}

function clearEpisodeSearch() {
    episodeSearchQuery = '';
    renderEpisodes(true);
    // Focus the search input after clearing
    const searchInput = document.querySelector('.playlist-search-input');
    if (searchInput) searchInput.focus();
}

// Swipe to hide episode
function setupEpisodeSwipeHandlers() {
    // Swipe-to-hide disabled for now.
    return;
}

// Teachers infinite scroll functions
let teachersScrollHandler = null;

function setupTeachersInfiniteScroll() {
    removeTeachersInfiniteScroll();
    
    teachersScrollHandler = () => {
        if (isLoadingMoreTeachers || teachersDisplayed >= sortedTeachers.length) return;
        
        const scrollPosition = window.innerHeight + window.scrollY;
        const threshold = document.body.offsetHeight - 500;
        
        if (scrollPosition >= threshold) {
            loadMoreTeachers();
        }
    };
    
    window.addEventListener('scroll', teachersScrollHandler);
}

function removeTeachersInfiniteScroll() {
    if (teachersScrollHandler) {
        window.removeEventListener('scroll', teachersScrollHandler);
        teachersScrollHandler = null;
    }
}

function loadMoreTeachers() {
    if (isLoadingMoreTeachers || teachersDisplayed >= sortedTeachers.length) return;
    
    isLoadingMoreTeachers = true;
    
    // Show loading indicator
    const indicator = document.getElementById('teachersLoadMoreIndicator');
    if (indicator) {
        indicator.style.display = 'flex';
    }
    
    // Small delay for smoother UX
    setTimeout(() => {
        renderPopularTeachers(true);
        isLoadingMoreTeachers = false;
    }, 300);
}

// Track pending play request to debounce rapid switches
let pendingPlayRequest = null;

function playEpisode(id, autoPlay = true) {
    debugAudioLog('[playEpisode] starting', id);
    const episode = episodes.find(ep => ep.id === id);
    if (!episode) return;

    // Cancel any pending play request
    if (pendingPlayRequest) {
        clearTimeout(pendingPlayRequest);
        pendingPlayRequest = null;
    }

    currentEpisode = episode;
    
    // Update URL with talk parameter
    updateUrl({ teacher: currentTeacherId, talk: id });
    
    // Check for saved progress
    const savedProgress = getEpisodeProgress()[id];
    const resumePosition = savedProgress?.position || 0;

    // IMPORTANT: Stop and clear previous stream before loading new one
    // iOS Chrome: replace the entire <audio> element to better abort network/decoder work.
    if (IS_IOS_CHROME) {
        replaceAudioElement();
    } else {
        hardStopAudio();
    }
    audioDebug.plays += 1;
    
    // Small delay to let browser abort previous download (helps iOS Chrome)
    pendingPlayRequest = setTimeout(() => {
        pendingPlayRequest = null;
        
        // Keep preloading minimal; iOS Chrome can get aggressive.
        audio.preload = IS_IOS_CHROME ? 'none' : 'metadata';
        
        // Play directly from dharmaseed (works without CORS for basic playback)
        debugAudioLog('[playEpisode] src', episode.audioUrl);
        audioDebug.lastSrc = episode.audioUrl;
        audio.src = episode.audioUrl;
        audio.playbackRate = speeds[speedIndex];
        
        // Resume from saved position if available and not near the end
        if (resumePosition > 0 && savedProgress?.percent < 95) {
            audio.addEventListener('loadedmetadata', function onLoaded() {
                audio.currentTime = resumePosition;
            }, { once: true });
        }
        
        if (autoPlay) {
            debugAudioLog('[playEpisode] autoPlay');
            audio.play();
        }
    }, 50); // 50ms delay to let browser cleanup

    playerTitle.textContent = episode.title;
    const playerTitleMobile = document.getElementById('playerTitleMobile');
    if (playerTitleMobile) playerTitleMobile.textContent = episode.title;
    
    // Update player with teacher info
    const playerArtist = document.getElementById('playerArtist');
    const playerPhoto = document.getElementById('playerPhoto');
    
    if (window.currentTeacherInfo) {
        playerArtist.textContent = window.currentTeacherInfo.name;
        if (window.currentTeacherInfo.photo) {
            playerPhoto.src = window.currentTeacherInfo.photo;
            playerPhoto.style.display = 'block';
        }
    }
    
    // Update Media Session for lock screen controls
    updateMediaSession();
    
    player.classList.add('visible');
    document.body.classList.add('player-active');
    
    updatePlayButton(autoPlay);
    updateEpisodePlayingState();
}

// Media Session API for background playback and lock screen controls
function updateMediaSession() {
    if ('mediaSession' in navigator && currentEpisode) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: currentEpisode.title,
            artist: window.currentTeacherInfo?.name || 'Dharmaseed',
            album: 'Dharma Talks',
            artwork: window.currentTeacherInfo?.photo ? [
                { src: window.currentTeacherInfo.photo, sizes: '512x512', type: 'image/jpeg' }
            ] : []
        });
        
        navigator.mediaSession.setActionHandler('play', () => {
            audio.play();
            updatePlayButton(true);
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            audio.pause();
            updatePlayButton(false);
        });
        navigator.mediaSession.setActionHandler('seekbackward', () => {
            audio.currentTime = Math.max(0, audio.currentTime - 15);
        });
        navigator.mediaSession.setActionHandler('seekforward', () => {
            audio.currentTime = Math.min(audio.duration, audio.currentTime + 15);
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            if (currentEpisode) {
                const currentIndex = episodes.findIndex(ep => ep.id === currentEpisode.id);
                if (currentIndex > 0) {
                    playEpisode(episodes[currentIndex - 1].id);
                }
            }
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            if (currentEpisode) {
                const currentIndex = episodes.findIndex(ep => ep.id === currentEpisode.id);
                if (currentIndex < episodes.length - 1) {
                    playEpisode(episodes[currentIndex + 1].id);
                }
            }
        });
    }
}

// Update playing state without re-rendering the whole list
function updateEpisodePlayingState() {
    document.querySelectorAll('.episode').forEach(el => {
        const epId = parseInt(el.dataset.id);
        if (currentEpisode && epId === currentEpisode.id) {
            el.classList.add('playing');
        } else {
            el.classList.remove('playing');
        }
    });
}

function togglePlay() {
    if (audio.paused) {
        audio.play();
        updatePlayButton(true);
    } else {
        audio.pause();
        updatePlayButton(false);
    }
}

function updatePlayButton(isPlaying) {
    const playBtn = document.querySelector('.play-btn');
    playIcon.style.display = isPlaying ? 'none' : 'block';
    pauseIcon.style.display = isPlaying ? 'block' : 'none';
    if (isPlaying) {
        playBtn.classList.add('playing');
    } else {
        playBtn.classList.remove('playing');
    }
}

function formatTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function debugAudioLog(...args) {
    if (!DEBUG_AUDIO) return;
    // Keep logs lightweight; iOS Chrome can get slow with huge console spam.
    console.log(...args);
}

function hardStopAudio() {
    try {
        audio.pause();
    } catch {}
    try {
        audio.removeAttribute('src');
        audio.load();
    } catch {}
}

// Audio element replacement: helps iOS Chrome stop piling up full MP3 downloads/decoders.


function onAudioTimeUpdate() {
    if (isDragging) return; // Don't update during drag
    currentTimeEl.textContent = formatTime(audio.currentTime);
    const progress = (audio.currentTime / audio.duration) * 100;
    progressFill.style.width = progress + '%';
    updateEpisodeProgressIndicator();
}

function onAudioLoadedMetadata() {
    totalTimeEl.textContent = formatTime(audio.duration);
}

function onAudioEnded() {
    updatePlayButton(false);
    if (currentEpisode) {
        const currentIndex = episodes.findIndex(ep => ep.id === currentEpisode.id);
        if (currentIndex < episodes.length - 1) {
            playEpisode(episodes[currentIndex + 1].id);
        }
    }
}

function onAudioPlay() {
    updatePlayButton(true);
    startPlaybackSaveInterval();
}

function onAudioPause() {
    updatePlayButton(false);
    savePlaybackState();
    stopPlaybackSaveInterval();
}

function addDebugEvent(type) {
    if (!DEBUG_AUDIO) return;
    try {
        audioDebug.events.push({
            t: Date.now(),
            id: audioInstanceId,
            type,
            networkState: audio.networkState,
            readyState: audio.readyState,
            src: audio.currentSrc || audio.src || ''
        });
        if (audioDebug.events.length > 200) audioDebug.events.shift();
    } catch {}
}

function bindAudioEventHandlers(el) {
    if (!el) return;
    if (audioHandlersBoundTo === el) return;

    // Unbind from previous element
    if (audioHandlersBoundTo) {
        try {
            audioHandlersBoundTo.removeEventListener('timeupdate', onAudioTimeUpdate);
            audioHandlersBoundTo.removeEventListener('loadedmetadata', onAudioLoadedMetadata);
            audioHandlersBoundTo.removeEventListener('ended', onAudioEnded);
            audioHandlersBoundTo.removeEventListener('play', onAudioPlay);
            audioHandlersBoundTo.removeEventListener('pause', onAudioPause);
        } catch {}
    }

    audioHandlersBoundTo = el;
    el.addEventListener('timeupdate', onAudioTimeUpdate);
    el.addEventListener('loadedmetadata', onAudioLoadedMetadata);
    el.addEventListener('ended', onAudioEnded);
    el.addEventListener('play', onAudioPlay);
    el.addEventListener('pause', onAudioPause);

    if (DEBUG_AUDIO) {
        // Minimal event surface to avoid overhead
        ['loadstart', 'progress', 'stalled', 'suspend', 'abort', 'error', 'waiting', 'canplay'].forEach(evt => {
            el.addEventListener(evt, () => addDebugEvent(evt), { passive: true });
        });
    }
}

function replaceAudioElement() {
    const oldEl = audio;
    const parent = oldEl?.parentNode;
    if (!oldEl || !parent) return;

    // Attempt to stop any ongoing work on the old element.
    try {
        oldEl.pause();
        oldEl.removeAttribute('src');
        oldEl.load();
    } catch {}

    const newEl = document.createElement('audio');
    newEl.id = 'audio';
    newEl.preload = 'none';
    // iOS: avoid full-screen takeover
    newEl.setAttribute('playsinline', '');
    newEl.setAttribute('webkit-playsinline', '');

    parent.replaceChild(newEl, oldEl);
    audio = newEl;
    window.audio = newEl;
    audioInstanceId += 1;
    audioDebug.resets += 1;
    bindAudioEventHandlers(newEl);

    debugAudioLog('[audio] replaced element; instance', audioInstanceId);
}

if (DEBUG_AUDIO) {
    window.dumpAudioState = () => {
        try {
            const buffered = [];
            for (let i = 0; i < audio.buffered.length; i++) {
                buffered.push([audio.buffered.start(i), audio.buffered.end(i)]);
            }
            return {
                instanceId: audioInstanceId,
                src: audio.currentSrc || audio.src || '',
                networkState: audio.networkState,
                readyState: audio.readyState,
                currentTime: audio.currentTime,
                duration: audio.duration,
                buffered
            };
        } catch (e) {
            return { error: String(e) };
        }
    };
}

// Throttled update of episode progress in list
let lastProgressUpdate = 0;
function updateEpisodeProgressIndicator() {
    if (!currentEpisode || !audio.duration) return;
    const now = Date.now();
    if (now - lastProgressUpdate < 5000) return; // Update every 5 seconds
    lastProgressUpdate = now;
    
    const pct = Math.round((audio.currentTime / audio.duration) * 100);
    const displayPct = pct >= 95 ? '100' : pct;
    
    const progressEl = document.querySelector(`.episode[data-id="${currentEpisode.id}"] .episode-progress`);
    if (progressEl) {
        progressEl.textContent = displayPct + '%';
    } else if (pct > 0) {
        // Add progress element if it doesn't exist
        const rightEl = document.querySelector(`.episode[data-id="${currentEpisode.id}"] .episode-right`);
        if (rightEl && !rightEl.querySelector('.episode-progress')) {
            const span = document.createElement('span');
            span.className = 'episode-progress';
            span.setAttribute('data-talk-id', currentEpisode.id);
            span.textContent = displayPct + '%';
            rightEl.appendChild(span);
        }
    }
}

// Audio listeners are bound via bindAudioEventHandlers(audio) so they survive <audio> replacement.
bindAudioEventHandlers(audio);

function seek(event) {
    const rect = progressBar.getBoundingClientRect();
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    audio.currentTime = percent * audio.duration;
}

// Drag seeking for progress bar
let isDragging = false;
let dragPercent = 0;

function getSeekPercent(event) {
    const rect = progressBar.getBoundingClientRect();
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}

function updateProgressVisual(percent) {
    progressFill.style.width = (percent * 100) + '%';
    if (audio.duration) {
        const time = percent * audio.duration;
        currentTimeEl.textContent = formatTime(time);
    }
}

function startDrag(event) {
    if (!audio.duration) return;
    isDragging = true;
    progressFill.classList.add('dragging');
    dragPercent = getSeekPercent(event);
    updateProgressVisual(dragPercent);
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchmove', onDrag, { passive: false });
    document.addEventListener('touchend', stopDrag);
}

function onDrag(event) {
    if (!isDragging) return;
    event.preventDefault();
    dragPercent = getSeekPercent(event);
    updateProgressVisual(dragPercent);
}

function stopDrag() {
    if (isDragging && audio.duration) {
        audio.currentTime = dragPercent * audio.duration;
    }
    isDragging = false;
    progressFill.classList.remove('dragging');
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
    document.removeEventListener('touchmove', onDrag);
    document.removeEventListener('touchend', stopDrag);
}

// Set up drag listeners on progress bar
progressBar.addEventListener('mousedown', startDrag);
progressBar.addEventListener('touchstart', startDrag, { passive: false });

function cycleSpeed() {
    speedIndex = (speedIndex + 1) % speeds.length;
    audio.playbackRate = speeds[speedIndex];
    speedBtn.textContent = speeds[speedIndex] + 'x';
}

async function shareEpisode() {
    if (!currentEpisode || !currentTeacherId) return;
    
    const url = new URL(window.location.href.split('?')[0]);
    url.searchParams.set('teacher', currentTeacherId);
    url.searchParams.set('talk', currentEpisode.id); // Real Dharmaseed talk ID
    
    const shareUrl = url.toString();
    
    try {
        if (navigator.share) {
            // Only use title and url - text causes duplication on some platforms
            await navigator.share({
                title: currentEpisode.title,
                url: shareUrl
            });
        } else {
            await navigator.clipboard.writeText(shareUrl);
        }
    } catch (err) {
        // Fallback: copy to clipboard
        try {
            await navigator.clipboard.writeText(shareUrl);
        } catch {
            console.error('Could not share or copy:', err);
        }
    }
}

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    
    switch(e.code) {
        case 'Space':
            e.preventDefault();
            togglePlay();
            break;
        case 'ArrowLeft':
            audio.currentTime = Math.max(0, audio.currentTime - 15);
            break;
        case 'ArrowRight':
            audio.currentTime = Math.min(audio.duration, audio.currentTime + 15);
            break;
    }
});

// Initialize - load teachers database
async function init() {
    const grid = document.getElementById('popularGrid');
    grid.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading teachers...</p></div>';
    
    try {
        const response = await fetch('db/dharmaseed_teachers.json');
        const data = await response.json();
        TEACHERS_DB = data.teachers;
        console.log(`Loaded ${TEACHERS_DB.length} teachers`);
        renderPopularTeachers();
        
        // Set up teachers infinite scroll
        setupTeachersInfiniteScroll();
        
        // Check URL params for deep linking first
        const params = new URLSearchParams(window.location.search);
        if (params.get('teacher')) {
            // Deep link takes priority
            checkUrlParams();
        } else {
            // No deep link, check for resume state
            checkResumeState();
        }
    } catch (error) {
        console.error('Error loading teachers database:', error);
        grid.innerHTML = `
            <div class="loading">
                <p>Could not load teachers database.</p>
                <p style="font-size: 0.85rem; color: var(--text-muted);">Make sure profs/dharmaseed_teachers.json exists.</p>
            </div>
        `;
    }
}

function checkResumeState() {
    const state = getPlaybackState();
    if (!state) return;
    
    // Check if saved state is less than 7 days old
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - state.timestamp > maxAge) {
        clearPlaybackState();
        return;
    }
    
    const progress = state.duration > 0 ? (state.position / state.duration) : 0;
    const isNearEnd = progress >= 0.9;
    
    showResumeDialog(state, isNearEnd);
}

function showResumeDialog(state, isNearEnd) {
    const progress = state.duration > 0 ? Math.round((state.position / state.duration) * 100) : 0;
    const circumference = 2 * Math.PI * 21; // radius = 21
    const dashOffset = circumference - (progress / 100) * circumference;
    
    const overlay = document.createElement('div');
    overlay.className = 'resume-overlay';
    overlay.innerHTML = `
        <div class="resume-dialog">
            <h3>${isNearEnd ? 'Welcome back!' : 'Continue listening?'}</h3>
            <div class="track-info">
                <div class="track-title">${state.talkTitle}</div>
                ${!isNearEnd ? `
                    <div class="progress-circle">
                        <svg viewBox="0 0 50 50">
                            <circle class="bg" cx="25" cy="25" r="21"/>
                            <circle class="progress" cx="25" cy="25" r="21" 
                                stroke-dasharray="${circumference}" 
                                stroke-dashoffset="${dashOffset}"/>
                        </svg>
                        <span class="percent">${progress}%</span>
                    </div>
                ` : ''}
            </div>
            ${isNearEnd ? `<p>You finished this talk. Browse more from ${state.teacherName}?</p>` : ''}
            <div class="resume-buttons">
                <button class="resume-btn secondary" onclick="dismissResume()">Start Fresh</button>
                <button class="resume-btn primary" onclick="acceptResume(${state.teacherId}, ${state.talkId}, ${state.position}, ${isNearEnd})">
                    ${isNearEnd ? 'View Teacher' : 'Continue'}
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
}

function dismissResume() {
    const overlay = document.querySelector('.resume-overlay');
    if (overlay) overlay.remove();
    clearPlaybackState();
}

async function acceptResume(teacherId, talkId, position, isNearEnd) {
    const overlay = document.querySelector('.resume-overlay');
    if (overlay) overlay.remove();
    
    await selectTeacher(teacherId);
    
    if (!isNearEnd) {
        // Resume playback at saved position
        const checkAndResume = () => {
            if (episodes.length > 0) {
                const episode = episodes.find(ep => ep.id === talkId);
                if (episode) {
                    playEpisode(talkId);
                    // Set position after audio loads
                    audio.addEventListener('loadedmetadata', function onLoad() {
                        audio.currentTime = position;
                    }, { once: true });
                    scrollToEpisode(talkId);
                } else if (isLoadingAllTalks) {
                    setTimeout(checkAndResume, 500);
                }
            } else {
                setTimeout(checkAndResume, 500);
            }
        };
        setTimeout(checkAndResume, 1000);
    }
}

// Check URL params for deep linking (shared links)
async function checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const teacherId = params.get('teacher');
    const talkId = params.get('talk') || params.get('episode'); // Support both for backwards compat
    
    if (teacherId) {
        const tid = parseInt(teacherId);
        const teacher = TEACHERS_DB.find(t => t.id === tid);
        
        if (teacher) {
            await selectTeacher(tid);
            
            // If talk specified, wait for episodes to load then play it
            if (talkId !== null && talkId !== '') {
                const targetId = parseInt(talkId);
                // Wait for episodes to load, check periodically
                const checkAndPlay = () => {
                    if (episodes.length > 0) {
                        const episode = episodes.find(ep => ep.id === targetId);
                        if (episode) {
                            playEpisode(targetId, false); // Don't auto-play from URL
                            // Scroll to the episode in the list (centered)
                            scrollToEpisode(targetId);
                        } else {
                            // If not found yet and background loading in progress, wait longer
                            if (isLoadingAllTalks) {
                                setTimeout(checkAndPlay, 500);
                            } else {
                                console.warn('Talk not found:', targetId, 'Available IDs:', episodes.map(e => e.id));
                            }
                        }
                    } else {
                        // Episodes not loaded yet, try again
                        setTimeout(checkAndPlay, 500);
                    }
                };
                setTimeout(checkAndPlay, 1000);
            }
        }
    }
}

function scrollToEpisode(episodeId) {
    // Small delay to ensure DOM is rendered
    setTimeout(() => {
        const episodeEl = document.querySelector(`.episode[data-id="${episodeId}"]`);
        if (episodeEl) {
            episodeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 100);
}

init();
