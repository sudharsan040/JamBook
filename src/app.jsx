import React from "react";
import ReactDOM from "react-dom/client";


// ─── Curated songs (placeholder lines — not real copyrighted lyrics) ──
const CURATED = [];

const TAG_CONFIG    = {male:{label:"Male",class:"tag-male"},female:{label:"Female",class:"tag-female"},chorus:{label:"Chorus",class:"tag-chorus"},duet:{label:"Duet",class:"tag-duet"},humming:{label:"Humming",class:"tag-humming"}};
const LANGUAGES     = ["All","Tamil","Hindi","Telugu","Malayalam","Kannada","English"];
const SCROLL_SPEEDS = [{label:"Slow",key:"slow",px:18},{label:"Medium",key:"medium",px:45},{label:"Fast",key:"fast",px:90}];
const FONT_SCALES   = [0.85, 1, 1.15, 1.35, 1.6, 2, 2.5]; // 1 (index 1) = default 100%
const LANG_COLORS   = {Tamil:"bg-orange-900/30 text-orange-400",Hindi:"bg-blue-900/30 text-blue-400",Telugu:"bg-green-900/30 text-green-400",Malayalam:"bg-pink-900/30 text-pink-400",Kannada:"bg-yellow-900/30 text-yellow-400",English:"bg-teal-900/30 text-teal-400"};
const AVATAR_COLORS = ["#7c3aed","#0891b2","#059669","#d97706","#db2777","#dc2626","#4f46e5","#0d9488"];

// ─── Supabase backend (cross-device sync) ─────────────────────────────
// `process.env.SUPABASE_URL` / `SUPABASE_KEY` are LITERAL references that
// esbuild replaces at build time via build.mjs `define:`.
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
// Our own Cloudflare Worker proxy — safe to hardcode (the Worker is public
// and has no secrets; CORS proxies aren't security-sensitive). Leave blank
// to disable tamil2lyrics (lrclib still works direct).
const CORS_PROXY_URL = "https://jambook-proxy.lssusan173.workers.dev/?url=";
const HAS_PROXY      = !!CORS_PROXY_URL;
// Same Worker, different route — it holds the Spotify Client Credentials
// token exchange server-side (see the Worker's /spotify handler), so the
// frontend never sees the client secret or the access token's origin call.
const SPOTIFY_PROXY_BASE = CORS_PROXY_URL ? CORS_PROXY_URL.replace(/\/\?url=$/, "") : "";
const HAS_SPOTIFY    = !!SPOTIFY_PROXY_BASE;

const sb = (SUPABASE_URL && SUPABASE_KEY && window.supabase)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;
const HAS_SUPABASE = !!sb;

// ─── Google Sheets sync (song archive → a real, always-current sheet) ────
// Entirely server-side: jambook-proxy (same Worker used for Spotify) holds
// a Google service-account key + the target Sheet ID as secrets, and does
// the whole read-from-Supabase + write-to-Sheet round trip itself. The
// frontend only ever sees a single button — no OAuth popup, no Sheet ID,
// no per-user sign-in.
const SHEETS_SYNC_URL = SPOTIFY_PROXY_BASE ? `${SPOTIFY_PROXY_BASE}/sheets-sync` : "";
const HAS_SHEETS_SYNC  = !!SHEETS_SYNC_URL;

async function syncSongArchiveToSheet() {
  const res = await fetch(SHEETS_SYNC_URL);
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(json?.error || `Sync failed (${res.status})`);
  return json.count;
}

// Supabase Auth needs an email — we synthesise one from the username
const usernameToEmail = u => `${u.toLowerCase().replace(/[^a-z0-9_]/g,"_")}@jambook.app`;

// ─── API helpers ──────────────────────────────────────────────────────

// iTunes Search API — free, no key, works in India.
// NOTE: iTunes Search has NO offset/pagination param. The only knob is `limit`
// (max 200). We hit multiple regional stores in parallel + dedupe to maximise
// the pool, then paginate client-side.
const PAGE_SIZE   = 25;
const POOL_SIZE   = 200;
// Single store on mobile (bandwidth-friendly), 3 stores on desktop for richer results
const ITUNES_STORES = (typeof window !== "undefined" && window.innerWidth < 768)
  ? ["in"]
  : ["in", "us", "gb"];

async function searchOneStore(query, country) {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=${POOL_SIZE}&country=${country}`;
    const r   = await fetch(url);
    if (!r.ok) return [];
    const d   = await r.json();
    return d.results || [];
  } catch { return []; }
}

function mapItunesTrack(t) {
  return {
    id: `it_${t.trackId}`, type: "live", itunesId: t.trackId,
    title: t.trackName, artist: t.artistName, album: t.collectionName || "",
    cover: t.artworkUrl100, preview: t.previewUrl, language: "Unknown",
  };
}

// Spotify — our primary source: official API, generous rate limits, correct
// pagination (unlike iTunes, which has none). Goes through our own Worker,
// which holds the Client Credentials token server-side (see /spotify route);
// `path` here is a full Spotify Web API path + query string.
async function spotifyFetch(path) {
  if (!HAS_SPOTIFY) return null;
  try {
    const r = await fetch(`${SPOTIFY_PROXY_BASE}/spotify?path=${encodeURIComponent(path)}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// `opts.album`/`opts.cover` override the track's own (missing, in the
// album-tracks endpoint) album metadata when fetching a specific album's
// tracklist — search results already carry a full nested `album` object.
function mapSpotifyTrack(t, opts = {}) {
  const images = t.album?.images || [];
  return {
    id: `sp_${t.id}`, type: "live", itunesId: null, spotifyId: t.id,
    title: t.name,
    artist: (t.artists || []).map(a => a.name).filter(Boolean).join(", ") || "Unknown",
    album: opts.album ?? t.album?.name ?? "",
    cover: opts.cover ?? images[0]?.url ?? "",
    preview: t.preview_url || null,
    language: "Unknown", // Spotify doesn't expose a per-track language
  };
}

async function searchSpotifySongs(query) {
  const d = await spotifyFetch(`/v1/search?q=${encodeURIComponent(query)}&type=track&market=IN&limit=25`);
  return (d?.tracks?.items || []).map(t => mapSpotifyTrack(t));
}

async function searchSpotifyAlbums(query) {
  const d = await spotifyFetch(`/v1/search?q=${encodeURIComponent(query)}&type=album&market=IN&limit=10`);
  return d?.albums?.items || null;
}

async function fetchSpotifyAlbumTracks(albumId, albumName, albumCover) {
  const d = await spotifyFetch(`/v1/albums/${encodeURIComponent(albumId)}/tracks?market=IN&limit=50`);
  return (d?.items || []).map(t => mapSpotifyTrack(t, { album: albumName, cover: albumCover }));
}

async function searchSpotifyArtists(query) {
  const d = await spotifyFetch(`/v1/search?q=${encodeURIComponent(query)}&type=artist&market=IN&limit=5`);
  return d?.artists?.items || null;
}

async function resolveSpotifyArtist(query) {
  const results = await searchSpotifyArtists(query);
  if (results === null) return { artist: null, failed: true };
  if (!results.length) return { artist: null, failed: false };
  const qNorm = normalizeForMatch(query);
  const a = results.find(x => normalizeForMatch(x.name || "") === qNorm) || results[0];
  return { artist: { id: a.id, name: a.name }, failed: false };
}

// No single "page through all songs by this artist" endpoint on Spotify —
// closest equivalent is albums, then each album's tracks. Capped at a
// reasonable number of albums so this stays a bounded number of requests;
// used as the SECOND fallback (JioSaavn's dedicated endpoint is the primary
// for artist-mode browsing — real pagination through a much deeper catalogue).
async function fetchSpotifyArtistSongPool(artistId) {
  const d = await spotifyFetch(`/v1/artists/${encodeURIComponent(artistId)}/albums?market=IN&limit=20&include_groups=album,single`);
  if (d === null) return { songs: [], failed: true };
  const albums = d.items || [];
  if (!albums.length) return { songs: [], failed: false };
  const lists = await Promise.all(albums.map(a => fetchSpotifyAlbumTracks(a.id, a.name, a.images?.[0]?.url)));
  const seen = new Set(), out = [];
  for (const list of lists) for (const s of list) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
  return { songs: out, failed: false };
}

// iTunes fallback for Movie/Artist mode — used when JioSaavn (our primary,
// deeper-catalogue source for Indian film music) is unavailable or comes up
// empty. iTunes has no documented rate limit and needs no proxy, but its
// artist/album coverage for Indian regional content is thinner, and it
// doesn't expose a per-track language, so results here skip language
// filtering entirely rather than silently filtering everything out.
async function fetchItunesAlbumSongs(query) {
  let albums;
  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=album&limit=10&country=in`);
    if (!r.ok) return { songs: [], failed: true };
    albums = (await r.json()).results || [];
  } catch { return { songs: [], failed: true }; }
  if (!albums.length) return { songs: [], failed: false };

  const qNorm   = normalizeForMatch(query);
  const exact   = albums.filter(a => normalizeForMatch(a.collectionName || "") === qNorm);
  const partial = albums.filter(a => fieldMatchesWholeWords(a.collectionName || "", query));
  const chosen  = (exact.length ? exact : partial).slice(0, 3);
  if (!chosen.length) return { songs: [], failed: false };

  const lists = await Promise.all(chosen.map(async (a) => {
    try {
      const r = await fetch(`https://itunes.apple.com/lookup?id=${a.collectionId}&entity=song&limit=200`);
      if (!r.ok) return [];
      const d = await r.json();
      return (d.results || []).filter(t => t.wrapperType === "track").map(mapItunesTrack);
    } catch { return []; }
  }));
  const seen = new Set(), out = [];
  for (const list of lists) for (const s of list) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
  return { songs: out, failed: false };
}

async function resolveItunesArtist(query) {
  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=musicArtist&limit=5&country=in`);
    if (!r.ok) return { artist: null, failed: true };
    const artists = (await r.json()).results || [];
    if (!artists.length) return { artist: null, failed: false };
    const qNorm = normalizeForMatch(query);
    const a = artists.find(x => normalizeForMatch(x.artistName || "") === qNorm) || artists[0];
    return { artist: { id: a.artistId, name: a.artistName }, failed: false };
  } catch { return { artist: null, failed: true }; }
}

async function fetchItunesArtistSongs(artistId) {
  try {
    const r = await fetch(`https://itunes.apple.com/lookup?id=${artistId}&entity=song&limit=200`);
    if (!r.ok) return { songs: [], failed: true };
    const d = await r.json();
    return { songs: (d.results || []).filter(t => t.wrapperType === "track").map(mapItunesTrack), failed: false };
  } catch { return { songs: [], failed: true }; }
}

// JioSaavn (unofficial) — an Indian streaming catalogue whose film songs are
// tagged with the correct movie as `album` and carry an explicit `language`
// field, both far more reliable for Indian regional music than iTunes' generic
// global catalogue (which has no language filter and mixes in unrelated
// covers/compilations). Self-hosted on our own Cloudflare Worker (forked from
// sumitkolhe/jiosaavn-api) after the shared public instance (saavn.sumit.co)
// proved unreliable under load — same API shape, just no longer shared with
// everyone else using that free instance.
const JIOSAAVN_BASE = "https://jiosaavn-api.lssusan173.workers.dev/api";

function capitalizeLang(l) {
  if (!l) return "";
  return l.charAt(0).toUpperCase() + l.slice(1).toLowerCase();
}

// Generic GET against the JioSaavn API — tries direct fetch first, falls back
// through our CORS proxy since this hosted instance has no confirmed CORS.
// The hosted JioSaavn instance is a free, shared, unofficial API — it does
// occasionally 429 (rate limit) under load with no SLA. Retry with a short
// backoff on 429 specifically (direct, then again through the proxy, which
// is also a different source IP and may not be rate-limited the same way)
// before giving up.
async function jiosaavnFetchOnce(url, viaProxy) {
  const r = viaProxy ? await fetchViaProxy(url) : await fetch(url);
  if (r.status === 429) { const e = new Error("rate limited"); e.rateLimited = true; throw e; }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}
async function jiosaavnFetch(path) {
  const url = `${JIOSAAVN_BASE}${path}`;
  for (const viaProxy of [false, true]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await jiosaavnFetchOnce(url, viaProxy);
      } catch (e) {
        if (e.rateLimited && attempt === 0) {
          await new Promise(res => setTimeout(res, 900 * (attempt + 1)));
          continue;
        }
        break; // non-rate-limit error, or out of retries — try next transport
      }
    }
  }
  return null; // both transports failed — caller distinguishes this from "genuinely no results"
}

async function searchJioSaavn(query) {
  const d = await jiosaavnFetch(`/search/songs?query=${encodeURIComponent(query)}&limit=${POOL_SIZE}`);
  return d?.data?.results || [];
}

// ── Album (movie) and artist lookups — used by the audience request page's
// Movie/Artist filters so they return a whole soundtrack/discography instead
// of whatever a generic song-title search happens to also match.
// These return `null` specifically when the fetch itself failed (e.g. the
// API is rate-limited) — distinct from a successful response with zero
// matches — so callers can tell "couldn't check" apart from "genuinely none".
async function searchJioSaavnAlbums(query) {
  const d = await jiosaavnFetch(`/search/albums?query=${encodeURIComponent(query)}&limit=10`);
  if (d === null) return null;
  return d?.data?.results || [];
}
async function fetchJioSaavnAlbumSongs(albumId) {
  const d = await jiosaavnFetch(`/albums?id=${encodeURIComponent(albumId)}`);
  return (d?.data?.songs || []).map(mapJioSaavnSong);
}
async function searchJioSaavnArtists(query) {
  const d = await jiosaavnFetch(`/search/artists?query=${encodeURIComponent(query)}&limit=10`);
  if (d === null) return null;
  return d?.data?.results || [];
}
const ARTIST_PAGE_SIZE = 10; // fixed page size the JioSaavn API itself uses
async function fetchJioSaavnArtistSongsPage(artistId, page) {
  const d = await jiosaavnFetch(`/artists/${encodeURIComponent(artistId)}/songs?page=${page}&sortBy=popularity&sortOrder=desc`);
  return { songs: (d?.data?.songs || []).map(mapJioSaavnSong), total: d?.data?.total || 0, failed: d === null };
}

// The API's own `language` query param is silently ignored (verified against
// the live endpoint — passing language=hindi vs language=telugu returned
// identical results), so a language filter has to be applied client-side.
// That can thin a raw page down to very few (or zero) matches, so this scans
// forward through consecutive raw pages — fetched in concurrent batches
// (rather than one at a time) so a rare-language search doesn't feel like a
// long hang — until it collects a full visible page of matches or the scan
// cap is reached.
const ARTIST_SCAN_CAP   = 24; // max raw pages to scan per visible page — bounds worst-case requests
const ARTIST_SCAN_BATCH = 4;  // raw pages fetched concurrently per round
async function fetchJioSaavnArtistPageFiltered(artistId, startRawPage, language) {
  let rawPage = startRawPage;
  let total = 0;
  let anyFailed = false;
  let exhausted = false; // true only once we've genuinely run out of the artist's catalog
  const collected = [];
  let scans = 0;

  while (collected.length < ARTIST_PAGE_SIZE && scans < ARTIST_SCAN_CAP && !exhausted) {
    const batchSize = Math.min(ARTIST_SCAN_BATCH, ARTIST_SCAN_CAP - scans);
    const pages = Array.from({ length: batchSize }, (_, i) => rawPage + i);
    const results = await Promise.all(pages.map(p => fetchJioSaavnArtistSongsPage(artistId, p)));
    rawPage += batchSize;
    scans += batchSize;

    for (const { songs, total: t, failed } of results) {
      if (failed) anyFailed = true;
      if (t) total = t;
      if (!songs.length) { exhausted = true; break; }
      collected.push(...(language === "All" ? songs : songs.filter(s => s.language === language)));
      if (songs.length < ARTIST_PAGE_SIZE) { exhausted = true; break; }
    }
  }

  return {
    songs: collected.slice(0, ARTIST_PAGE_SIZE),
    nextRawPage: rawPage,
    total,
    failed: anyFailed && collected.length === 0,
    // More raw catalog may exist even if this particular page came up short
    // (or empty) — only report "no more" when the source itself ran out.
    hasMore: !exhausted,
  };
}

// Movie mode: find the album(s) whose name matches the query — exact match
// preferred (so "singam" doesn't pull in "Singam 2" alongside it), falling
// back to any whole-word match — then return every song on those albums.
// Tries Spotify first (most reliable, correct tagging), then JioSaavn
// (still the best Indian-film catalogue when Spotify doesn't have it), then
// iTunes as the final safety net.
function pickAlbumsMatching(albums, query) {
  const qNorm   = normalizeForMatch(query);
  const exact   = albums.filter(a => normalizeForMatch(a.name) === qNorm);
  const partial = albums.filter(a => fieldMatchesWholeWords(a.name, query));
  return (exact.length ? exact : partial).slice(0, 3);
}

async function fetchSongsForMovie(query) {
  const spAlbums = await searchSpotifyAlbums(query);
  if (spAlbums !== null && spAlbums.length) {
    const chosen = pickAlbumsMatching(spAlbums, query);
    if (chosen.length) {
      const lists = await Promise.all(chosen.map(a => fetchSpotifyAlbumTracks(a.id, a.name, a.images?.[0]?.url)));
      const seen = new Set(), out = [];
      for (const list of lists) for (const s of list) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
      if (out.length) return { songs: out, failed: false, source: "spotify" };
    }
  }

  const jsAlbums = await searchJioSaavnAlbums(query);
  if (jsAlbums !== null && jsAlbums.length) {
    const chosen = pickAlbumsMatching(jsAlbums, query);
    if (chosen.length) {
      const lists = await Promise.all(chosen.map(a => fetchJioSaavnAlbumSongs(a.id)));
      const seen = new Set(), out = [];
      for (const list of lists) for (const s of list) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
      if (out.length) return { songs: out, failed: false, source: "jiosaavn" };
    }
  }

  const fallback = await fetchItunesAlbumSongs(query);
  return { ...fallback, source: "itunes" };
}

// Artist mode: resolve the best-matching artist (exact name match preferred),
// so the request page can page through their songs.
async function resolveJioSaavnArtist(query) {
  const results = await searchJioSaavnArtists(query);
  if (results === null) return { artist: null, failed: true };
  if (!results.length) return { artist: null, failed: false };
  const qNorm = normalizeForMatch(query);
  const artist = results.find(a => normalizeForMatch(a.name) === qNorm) || results[0];
  return { artist, failed: false };
}

// Shared search logic for both the audience request page and the main
// SearchPage — `mode` is "title" | "movie" | "artist". Title/movie modes
// resolve to a full result pool in one shot; artist mode resolves an artist
// identity once, then pages through their songs (see fetchJioSaavnArtistPageFiltered
// for why language filtering has to happen client-side, page by page).
function useCatalogSearch({ query, mode, language }) {
  const [results, setResults]         = React.useState([]);
  const [loading, setLoading]         = React.useState(false);
  const [artistId, setArtistId]       = React.useState(null);
  // 'jiosaavn' (primary — deep, real pagination, language-filterable) or
  // 'spotify'/'itunes' (fallback pools — capped, client-paginated; neither
  // tags per-track language, so a language filter correctly excludes all of
  // them rather than showing every language unfiltered).
  const [artistSource, setArtistSource] = React.useState(null);
  const [fallbackArtistPool, setFallbackArtistPool] = React.useState([]);
  const [artistNotFound, setArtistNotFound] = React.useState(false);
  const [artistPage, setArtistPage]   = React.useState(0);
  const [artistPageCursors, setArtistPageCursors] = React.useState([0]);
  const [artistTotal, setArtistTotal] = React.useState(0);
  const [artistHasMore, setArtistHasMore] = React.useState(true);
  // True only when EVERY source failed to even answer (e.g. everything is
  // rate-limited/down) — distinct from a successful search that found nothing.
  const [catalogError, setCatalogError] = React.useState(false);
  const [resultSource, setResultSource] = React.useState(null); // 'spotify' | 'jiosaavn' | 'itunes' | null
  const debounceRef = React.useRef(null);

  // Resolve the query: title/movie fetch results directly; artist mode only
  // resolves WHICH artist (+ which source) — the page-fetch effect handles paging.
  React.useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]); setArtistId(null); setArtistSource(null); setFallbackArtistPool([]);
      setArtistNotFound(false); setCatalogError(false);
      setArtistPage(0); setArtistPageCursors([0]); setArtistTotal(0);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      if (mode === "title") {
        const r = await searchSongs(q, language);
        setResults(r); setArtistId(null); setArtistNotFound(false); setCatalogError(false);
        setLoading(false);
      } else if (mode === "movie") {
        const { songs, failed, source } = await fetchSongsForMovie(q);
        setResults(songs); setArtistId(null); setArtistNotFound(false);
        setCatalogError(failed && !songs.length); setResultSource(source);
        setLoading(false);
      } else { // artist — JioSaavn primary (real pagination), Spotify then iTunes as fallback pools
        setArtistPage(0); setArtistPageCursors([0]);
        const js = await resolveJioSaavnArtist(q);
        if (js.artist) {
          setArtistSource("jiosaavn"); setResultSource("jiosaavn");
          setArtistNotFound(false); setCatalogError(false);
          setArtistId(js.artist.id); // page-fetch effect (jiosaavn branch) takes over
          return;
        }
        // JioSaavn had nothing (down, rate-limited, or genuinely no match) — try Spotify.
        const sp = await resolveSpotifyArtist(q);
        if (sp.artist) {
          const { songs } = await fetchSpotifyArtistSongPool(sp.artist.id);
          if (songs.length) {
            setArtistSource("spotify"); setResultSource("spotify");
            setFallbackArtistPool(songs); // page-fetch effect below applies the language filter + slices
            setArtistNotFound(false); setCatalogError(false);
            setArtistId(null);
            return;
          }
          // Resolved an artist but got no songs (or the fetch itself failed) —
          // still worth trying iTunes rather than giving up here.
        }
        // Spotify had nothing usable either — last resort, iTunes.
        const it = await resolveItunesArtist(q);
        if (it.artist) {
          const { songs } = await fetchItunesArtistSongs(it.artist.id);
          setArtistSource("itunes"); setResultSource("itunes");
          setFallbackArtistPool(songs); // page-fetch effect below applies the language filter + slices
          setArtistNotFound(false); setCatalogError(false);
          setArtistId(null);
        } else {
          setResults([]); setArtistId(null); setArtistSource(null);
          const allFailed = js.failed && sp.failed && it.failed;
          setCatalogError(allFailed);
          setArtistNotFound(!allFailed);
          setLoading(false);
        }
      }
    }, 600);
    return () => clearTimeout(debounceRef.current);
  }, [query, mode, language]);

  // Neither Spotify nor iTunes expose a per-track language, so every song
  // from those fallback pools is tagged "Unknown" (see mapSpotifyTrack /
  // mapItunesTrack) — filtering by a specific language against that pool
  // correctly yields nothing rather than silently showing every language,
  // which is what actually happened before this was applied (e.g. an A.R.
  // Rahman search with "Tamil" selected still showed his Hindi songs
  // whenever JioSaavn — the only source that DOES tag language — wasn't
  // the one serving the result).
  const isFallbackPool = artistSource === "spotify" || artistSource === "itunes";
  const filteredFallbackPool = React.useMemo(() => {
    if (!isFallbackPool) return [];
    return language === "All" ? fallbackArtistPool : fallbackArtistPool.filter(s => s.language === language);
  }, [fallbackArtistPool, isFallbackPool, language]);

  // Fetches/derives the current visible page of the resolved artist's songs
  // — fires on first resolve AND whenever the user pages forward/back.
  React.useEffect(() => {
    if (mode !== "artist") return;
    if (artistSource === "jiosaavn" && artistId) {
      (async () => {
        setLoading(true);
        const startRaw = artistPageCursors[artistPage] ?? 0;
        const { songs, nextRawPage, total, failed, hasMore } = await fetchJioSaavnArtistPageFiltered(artistId, startRaw, language);
        setResults(songs);
        setArtistTotal(total);
        setArtistHasMore(hasMore);
        setCatalogError(failed && !songs.length);
        setArtistPageCursors(prev => {
          if (prev[artistPage + 1] !== undefined) return prev;
          const next = [...prev]; next[artistPage + 1] = nextRawPage; return next;
        });
        setLoading(false);
      })();
    } else if (isFallbackPool) {
      // Already have the full (capped) pool in memory — filter by language,
      // then just slice locally.
      setResults(filteredFallbackPool.slice(artistPage * ARTIST_PAGE_SIZE, (artistPage + 1) * ARTIST_PAGE_SIZE));
      setArtistHasMore((artistPage + 1) * ARTIST_PAGE_SIZE < filteredFallbackPool.length);
      setLoading(false);
    }
  }, [mode, artistSource, artistId, artistPage, language, isFallbackPool, filteredFallbackPool]);

  // Total pages is only knowable when there's no language filter thinning
  // results out from under the raw page size (jiosaavn) — otherwise fall
  // back to artistHasMore to gate the Next button. The fallback pools are
  // always fully known up front, so their total is always computable.
  const artistTotalPages = isFallbackPool
    ? Math.max(1, Math.ceil(filteredFallbackPool.length / ARTIST_PAGE_SIZE))
    : (language === "All" ? Math.max(1, Math.ceil(artistTotal / ARTIST_PAGE_SIZE)) : null);

  return {
    results, loading, artistNotFound, catalogError, resultSource,
    artistActive: mode === "artist" && (!!artistId || isFallbackPool),
    artistPage, setArtistPage, artistTotalPages, artistHasMore,
    artistTotal: isFallbackPool ? filteredFallbackPool.length : artistTotal,
    // The one source with real per-track language data is unavailable right
    // now (down/rate-limited) and we've landed on a fallback pool instead —
    // a specific language pick can never match anything there.
    languageFilterUnavailable: isFallbackPool && language !== "All",
  };
}

// JioSaavn's API returns title/artist/album HTML-entity-encoded (e.g. a
// literal `&quot;` instead of `"`, `&amp;` instead of `&`) — decode via a
// detached <textarea>, the standard safe trick (its content is never parsed
// as live HTML or executed, just read back out as plain text).
function decodeHtmlEntities(str) {
  if (!str || str.indexOf("&") === -1) return str; // fast path — nothing to decode
  const el = document.createElement("textarea");
  el.innerHTML = str;
  return el.value;
}

function mapJioSaavnSong(s) {
  const artists = (s.artists?.primary || s.artists?.all || []).map(a => a.name).filter(Boolean).join(", ");
  const images  = s.image || [];
  return {
    id:         `js_${s.id}`,
    type:       "live",
    itunesId:   null,
    jiosaavnId: s.id,
    title:      decodeHtmlEntities(s.name),
    artist:     decodeHtmlEntities(artists) || "Unknown",
    album:      decodeHtmlEntities(s.album?.name) || "",
    cover:      images[images.length - 1]?.url || images[0]?.url || "",
    preview:    null, // JioSaavn's downloadUrl entries are full tracks, not short previews — skip rather than risk copyrighted playback
    language:   capitalizeLang(s.language) || "Unknown",
  };
}

async function searchSongs(query, language = "All") {
  // Append a language keyword to bias iTunes toward regional results.
  // iTunes Search has no language filter, so this is the pragmatic approach.
  const lang   = language && language !== "All" ? language : "";
  const term   = lang ? `${query} ${lang}` : query;

  const [spotifyResults, jioResults, ...itunesBatches] = await Promise.all([
    searchSpotifySongs(term),
    searchJioSaavn(query),
    ...ITUNES_STORES.map(c => searchOneStore(term, c)),
  ]);
  const all = itunesBatches.flat();

  // Dedupe across all three sources. Sources like Spotify often index the
  // SAME recording multiple times under different compilation/playlist
  // "albums" (e.g. a movie's official soundtrack AND a "Whistle Podu" mix
  // album), each with a slightly different subset/ordering of collaborator
  // names — so an exact "title|artist string" key doesn't catch them. Two
  // songs are treated as the same if the title matches and they share at
  // least one artist name in common (order/extra collaborators don't matter).
  // Spotify goes first (most reliable, correct tagging), then JioSaavn
  // (still the best for Indian film catalogue tagging when Spotify doesn't
  // have something), then iTunes fills in whatever's still missing.
  const normTitle = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const artistTokens = (a) => new Set(
    (a || "").toLowerCase().split(/[,&]/).map(x => x.replace(/[^a-z0-9]/g, "")).filter(Boolean)
  );
  const isSameSong = (a, b) => {
    if (normTitle(a.title) !== normTitle(b.title)) return false;
    const ta = artistTokens(a.artist), tb = artistTokens(b.artist);
    if (!ta.size || !tb.size) return true; // no artist info to compare — trust the title match
    for (const t of ta) if (tb.has(t)) return true;
    return false;
  };

  const out = [];
  const addIfNew = (song) => {
    if (out.some(existing => isSameSong(existing, song))) return;
    out.push(song);
  };
  for (const song of spotifyResults) addIfNew(song);
  for (const s of jioResults) {
    if (!s.id) continue;
    addIfNew(mapJioSaavnSong(s));
  }
  for (const s of all) {
    if (!s.trackId) continue;
    addIfNew({
      id:       `it_${s.trackId}`,
      type:     "live",
      itunesId: s.trackId,
      title:    s.trackName,
      artist:   s.artistName,
      album:    s.collectionName,
      cover:    s.artworkUrl100,
      preview:  s.previewUrl,
      language: lang || "Unknown",
    });
  }

  // ── Relevance filter ─────────────────────────────────────────────────
  // iTunes returns lots of fuzzy matches — searching "Maro Maro Tamil"
  // returns Justin Bieber etc. because "Tamil" matches some random field.
  // Strict pass: every query token must appear in title OR artist. If that
  // empties the list we relax to half-match. Then sort by relevance score.
  const queryTokens = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
  let filtered = out;
  if (queryTokens.length) {
    const queryLower = query.toLowerCase().trim();
    const scoreSong = (song) => {
      const title  = (song.title  || "").toLowerCase();
      const artist = (song.artist || "").toLowerCase();
      const album  = (song.album  || "").toLowerCase();
      let titleHits = 0, artistHits = 0, albumHits = 0;
      let titleArtistHits = 0;
      for (const t of queryTokens) {
        const inT = title.includes(t),  inA = artist.includes(t),  inAl = album.includes(t);
        if (inT)  titleHits++;
        if (inA)  artistHits++;
        if (inAl) albumHits++;
        if (inT || inA) titleArtistHits++;
      }
      let score = titleHits * 5 + artistHits * 2 + albumHits * 1;
      if (title === queryLower)         score += 100;     // exact title match
      else if (title.startsWith(queryLower)) score += 50; // title starts with query
      return { score, titleArtistHits };
    };

    const scored = out.map(s => ({ song: s, ...scoreSong(s) }));
    const strict = scored.filter(x => x.titleArtistHits === queryTokens.length);
    const half   = scored.filter(x => x.titleArtistHits >= Math.ceil(queryTokens.length / 2));
    filtered = (strict.length ? strict : half)
      .sort((a, b) => b.score - a.score)
      .map(x => x.song);
  }

  console.log(`[JamBook] search "${term}": ${spotifyResults.length} Spotify + ${jioResults.length} JioSaavn + ${all.length} iTunes raw → ${out.length} unique → ${filtered.length} relevant`);
  return filtered;
}

// ── Strip noise from titles for better API matching ───────────────────
function normalizeTitle(t) {
  return t
    .replace(/\(feat\..*?\)/gi,'').replace(/\[feat\..*?\]/gi,'')
    .replace(/\bft\..*$/gi,'').replace(/\(from\b.*?\)/gi,'')
    .replace(/\(.*?version\)/gi,'').replace(/\(.*?remix\)/gi,'')
    .trim();
}

// ── Fuzzy verification that a fetched lyrics result is actually for the
// song we asked for. Lyrics sources' own internal search/matching can be
// loose (e.g. a fuzzy search just picking its first hit), so without this a
// completely different song — or the same title from a DIFFERENT movie —
// can silently get returned and cached as if it were correct.
function normalizeForMatch(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9ऀ-ൿ\s]/g, " ").replace(/\s+/g, " ").trim();
}
function tokenOverlapScore(a, b) {
  const ta = new Set(normalizeForMatch(a).split(" ").filter(t => t.length >= 2));
  const tb = new Set(normalizeForMatch(b).split(" ").filter(t => t.length >= 2));
  if (!ta.size || !tb.size) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / Math.min(ta.size, tb.size);
}
// `expected` = what we searched for ({title, artist, album}); `got` = what a
// source handed back. Fails open (returns true) whenever a source doesn't
// expose enough metadata to compare — we only reject when we have real
// signal it's the wrong song.
function isPlausibleLyricsMatch(expected, got) {
  if (!got.title) return true;
  const titleScore = tokenOverlapScore(expected.title, got.title);
  if (titleScore < 0.5) return false;
  // An identical/near-identical title is exactly the scenario where two
  // different movies can share a song name — lean on album (movie) first,
  // falling back to artist, whichever the source actually gives us.
  if (got.album && expected.album) {
    if (tokenOverlapScore(expected.album, got.album) === 0) return false;
  } else if (got.artist && expected.artist) {
    if (tokenOverlapScore(expected.artist, got.artist) === 0 && titleScore < 0.99) return false;
  }
  return true;
}

// ── Detect Indic script of a text block ──────────────────────────────
function detectScript(text) {
  if (/[஀-௿]/.test(text)) return "tamil";
  if (/[ऀ-ॿ]/.test(text)) return "devanagari";
  if (/[ఀ-౿]/.test(text)) return "telugu";
  if (/[ಀ-೿]/.test(text)) return "kannada";
  if (/[ഀ-ൿ]/.test(text)) return "malayalam";
  return null;
}

// ── Custom Tamil → Tanglish phonetic transliterator ──────────────────
// Handles Tamil sandhi rules: voicing between vowels, geminate doubling,
// nasal contexts. Produces natural readable Tanglish like:
//   மூங்கில் தோட்டம் → "moongil thottam"
//   காதலிக்க → "kaadhalikka"
//   அன்பே → "anbe"
const TAMIL_VOWELS = {
  'அ':'a','ஆ':'aa','இ':'i','ஈ':'ee','உ':'u','ஊ':'oo',
  'எ':'e','ஏ':'e','ஐ':'ai','ஒ':'o','ஓ':'o','ஔ':'au'
};
const TAMIL_SIGNS = {
  'ா':'aa','ி':'i','ீ':'ee','ு':'u','ூ':'oo',
  'ெ':'e','ே':'e','ை':'ai','ொ':'o','ோ':'o','ௌ':'au'
};
// [wordStart, geminate, afterNasalOrVowel]
const TAMIL_CONS = {
  'க':['k','kk','g'],   'ங':['ng','ng','ng'],
  'ச':['s','chch','s'], 'ஞ':['gn','gn','nj'],
  'ட':['t','tt','d'],   'ண':['n','nn','n'],
  'த':['th','tth','dh'],'ந':['n','nn','n'],
  'ப':['p','pp','b'],   'ம':['m','mm','m'],
  'ய':['y','y','y'],    'ர':['r','rr','r'],
  'ல':['l','ll','l'],   'வ':['v','v','v'],
  'ழ':['zh','zh','zh'], 'ள':['l','ll','l'],
  'ற':['r','tr','r'],   'ன':['n','nn','n'],
  'ஜ':['j','j','j'],    'ஷ':['sh','sh','sh'],
  'ஸ':['s','s','s'],    'ஹ':['h','h','h'],
  'ஶ':['sh','sh','sh']
};
const TAMIL_NASALS = new Set(['ங','ஞ','ண','ந','ம','ன']);
const TAMIL_PULLI = '்';

function tamilToTanglish(text) {
  const isCons = c => TAMIL_CONS[c] !== undefined;
  const isVowel = c => TAMIL_VOWELS[c] !== undefined;
  const isSign  = c => TAMIL_SIGNS[c]  !== undefined;
  const isTamil = c => /[஀-௿]/.test(c);

  let out = "";
  let i = 0;
  let prev = "start"; // "start" | "vowel" | "nasal" | "consonant"

  while (i < text.length) {
    const ch = text[i];

    // Independent vowel
    if (isVowel(ch)) {
      out += TAMIL_VOWELS[ch];
      prev = "vowel"; i++;
      continue;
    }

    // Consonant cluster
    if (isCons(ch)) {
      // Geminate detection: ch + ் + same ch
      let geminate = false;
      let advance  = 1;
      if (text[i+1] === TAMIL_PULLI && text[i+2] === ch) {
        geminate = true; advance = 3;
      }

      const forms = TAMIL_CONS[ch];
      let form;
      if (geminate) form = forms[1];
      else if (prev === "vowel" || prev === "nasal") form = forms[2];
      else form = forms[0];

      out += form;

      // What's after the consonant cluster?
      const after = text[i + advance];
      if (isSign(after)) {
        out += TAMIL_SIGNS[after];
        prev = "vowel";
        i += advance + 1;
      } else if (after === TAMIL_PULLI) {
        // Bare consonant
        prev = TAMIL_NASALS.has(ch) ? "nasal" : "consonant";
        i += advance + 1;
      } else {
        // Inherent 'a' vowel
        out += "a";
        prev = "vowel";
        i += advance;
      }
      continue;
    }

    // Stray pulli (shouldn't happen but be safe)
    if (ch === TAMIL_PULLI) { i++; continue; }

    // Whitespace / punctuation / non-Tamil
    if (/\s/.test(ch))      prev = "start";
    else if (!isTamil(ch))  prev = "start";
    out += ch;
    i++;
  }

  // Post-cleanup: tidy artefacts
  out = out
    .replace(/aa+/g, "aa")              // collapse triple+ vowels
    .replace(/(\w)\1{2,}/g, "$1$1")     // collapse triple consonants
    // ─── Slang & spoken-Tamil polish ───────────────────────────────
    // Word-final 'u' after a consonant is usually silent in spoken Tamil:
    // "kaadhalu" → "kaadhal", "vandhaaru" → "vandhaar", "ponnu" → "ponnu" (kept if it's actually pronounced)
    // We're conservative: only drop 'u' if it follows a consonant cluster AND comes at word-end,
    // AND the original ended with a pulli (which we lose at this point). So instead, target
    // common patterns:
    .replace(/([bcdfghjklmnprstvyz]{2})u\b/g, "$1")        // double-cons + u at word end → drop u
    .replace(/\b(\w*?)dh\b/g, "$1dh")                      // keep dh at word end (no change, sanity)
    // Final inherent-a often pronounced as schwa/silent in slang:
    .replace(/([kgcjtdnpbmyrlvshz])a([\s.,!?]|$)/g, (m, c, end) => {
      // Keep 'a' if word is very short (likely a particle like "naa", "pa")
      return m.length <= 3 ? m : c + end;
    })
    // Common word patterns:
    .replace(/\benbathu\b/gi, "endhu")           // என்பது
    .replace(/\bizham\b/gi, "ezham")             // இழம்
    .replace(/\bkaattum\b/gi, "kaattum")
    // "endru" colloquially pronounced "endru" or "nnu" — keep formal
    .replace(/\bendru\b/gi, "endru")
    // ng + vowel: often pronounced just as ng (drop inherent a)
    .replace(/\bngga/g, "nga")
    // Drop trailing 'a' after a single consonant if preceded by long vowel
    .replace(/(aa|ee|oo|ae|ai|au)([bcdfghjklmnprstvyz])a\b/g, "$1$2");

  return out;
}

// ── English loanwords commonly written in Tamil script ───────────────
// Format: each entry is [englishSpelling, [phoneticVariants...]]
// Built broad — covers ~200 common loanwords across vehicles, tech,
// clothing, food, places, emotions, body parts, time, work, etc.
const LOANWORD_ENTRIES = [
  // vehicles
  ['cycle',['saikkil','saikil','saikkilu','saikkilae']],
  ['motor',['mottar','mottaar','moattar']],
  ['bike',['paik','baik','paikku']],
  ['car',['kaar','kaaru','car']],
  ['bus',['bas','bus','basu']],
  // 'rayil/reyil' removed — naturalized Tamil word, keep as "rayile"
  ['train',['train','trayinu','trayin']],
  ['plane',['plain','plaen']],
  ['aeroplane',['aeroplain','aeroplane','aeroplaen']],
  ['taxi',['taeksi','taksi']],
  ['auto',['oato','aato','aotto']],
  ['lorry',['lorri','laari']],
  ['truck',['trak','truk']],
  ['scooter',['skoottar','skutar','skoottare']],
  ['ship',['ship','shippu']],
  ['boat',['boat','bottu']],
  ['Maruti',['maaruthi','maaruti']],
  // tech / media
  ['phone',['phon','foan','phonu','foanu']],
  ['mobile',['mobail','moabail','mobailu']],
  ['camera',['kamera','kaamera','kaameraa']],
  ['computer',['kampyuter','komputer','kambyuttar']],
  ['laptop',['laeptop','laaptop','laeptaap']],
  ['TV',['tivi','teevee','teevi']],
  ['radio',['redio','reediyo','reedio']],
  ['internet',['intternet','intarnet']],
  ['online',['onlain','aanlain']],
  ['app',['aep','app']],
  ['video',['vidiyo','viideeyo','vidyo']],
  ['photo',['pottoa','footoa','poto']],
  ['message',['masej','messej','messaej']],
  ['email',['imel','eemail']],
  ['film',['film','filim','film']],
  ['cinema',['cinema','kinema','sinema']],
  ['record',['rekord','rekkard']],
  // 'sangu' removed — Tamil word for conch shell, not always "song"
  ['song',['song']],
  ['music',['myoosik','musik']],
  ['mike',['maik','maiku']],
  // clothing
  ['pant',['paent','paentu','paant']],
  ['pants',['paents','paentus']],
  ['baggy',['paeki','baeki']],
  ['jeans',['jeens','jins','jeansu']],
  ['shirt',['shert','sheert','shartu']],
  ['t-shirt',['ti-shert','tishert']],
  ['coat',['koat','kottu']],
  ['suit',['soot','suttu']],
  ['tie',['tai']],
  ['shoes',['shoes','shoosu','soosu']],
  ['boots',['boots','bootsu','boottu']],
  ['sandal',['saendal','sandal']],
  ['cap',['kaep']],
  ['hat',['haet']],
  ['belt',['belt','beltu']],
  ['dress',['dres','dressu']],
  ['skirt',['skart','skartu']],
  // 'sari' removed — collides with Tamil "சரி" (correct/okay)
  ['saree',['saaree']],
  // places
  ['school',['skool','iskool','school']],
  ['college',['kalej','kaalej','collage','kollej']],
  ['office',['aafis','ofis','office','aafisu']],
  ['hospital',['aaspataal','aspathri','hospital']],
  ['hotel',['hoatel','hotel','hoattal']],
  ['restaurant',['restorant','restaurant']],
  ['bar',['baar','bar']],
  ['shop',['shap','shaap','shop']],
  ['market',['markat','maarket']],
  ['mall',['maal','mall']],
  ['park',['paark','park']],
  ['beach',['beech','bich']],
  ['station',['steshan','sttaeshan']],
  ['airport',['erport','aerport']],
  ['theatre',['theyater','thieater','tiyetar']],
  ['library',['laibrary','laibrari']],
  ['bank',['baengk','bank']],
  ['city',['siti','city']],
  ['village',['vilej','village']],
  // food / drink
  ['coffee',['kafi','kaafi','kappi']],
  // 'tee' removed — collides with Tamil "தீ" (fire)
  ['tea',['tea']],
  ['milk',['milku','milkku']],
  ['water',['vaattar','vottar']],
  ['juice',['joos','joosu','joosi']],
  ['bread',['bred','brett']],
  ['butter',['battar','buttar']],
  ['cake',['keak','kaek']],
  ['biscuit',['biskut','biskett']],
  ['chocolate',['saaklet','chokolet','saakelet']],
  ['pizza',['pisa','pizza']],
  ['burger',['bargar','burgar']],
  ['sandwich',['saendvic','saendvich']],
  ['ice cream',['ais kreem','aiskreem']],
  ['sugar',['shukkar','sugar','shukkur']],
  // people / relations
  ['doctor',['daaktar','doctor','daktor']],
  ['master',['maastar','master']],
  ['sir',['sar','sir']],
  ['madam',['maedam','madam']],
  ['friend',['frend','frenddu']],
  ['brother',['bradar','brother']],
  ['sister',['sistar','sister']],
  ['uncle',['ankil','ungkil']],
  ['aunty',['aenti','aanti']],
  ['baby',['bebi','baeby']],
  ['lover',['lavar','lover']],
  // emotions / actions / interjections
  ['love',['laaf','lavu','lof','lov']],
  ['kiss',['kis','kissu']],
  ['hug',['hag','hagg']],
  ['smile',['smail','smaail']],
  ['miss',['mis','missu']],
  ['hi',['hai','hai']],
  ['hello',['hellow','helow','hellaa']],
  ['bye',['baai','baay','bai']],
  ['thank you',['thaengyu','thangyu','thaenkyu']],
  // 'sori' removed — collides with Tamil "சொரி" (itch)
  ['sorry',['saari','saaree']],
  ['please',['plees','pleesu']],
  ['ok',['oake','okay']],
  ['party',['paarti','party']],
  ['dance',['daens','daans']],
  ['style',['stail','staail']],
  ['super',['super','soopar']],
  // sports / entertainment
  ['cricket',['krikket','kriket']],
  ['football',['futbaal','futball']],
  ['ball',['baal','ball']],
  ['game',['gem','geem']],
  ['movie',['moovi','muvi']],
  // body
  ['eye',['ai']],
  ['lip',['lip','lippu']],
  ['hand',['haendu','hand']],
  ['leg',['leg','leggu']],
  ['heart',['haart','hartu']],
  ['face',['feys','feis']],
  ['body',['bodi','bady']],
  ['hair',['her','hair']],
  // money / work
  // 'manni' (forgive) / 'mani' (bell, hour) removed — Tamil words
  ['money',['money']],
  ['rupee',['roopay','roobaai']],
  ['dollar',['daalar','dollaar']],
  ['salary',['salari','saelari']],
  ['job',['jaab','jaabu']],
  ['work',['vark','work']],
  ['business',['bisnas','bizines']],
  ['boss',['baas','baasu']],
  ['company',['kampani','kompani']],
  // time / quantity
  ['time',['taim','taymu']],
  ['day',['de','day']],
  ['night',['nait','naytu']],
  ['week',['veek','week']],
  ['month',['mant','manttu']],
  ['year',['iyar','year']],
  ['number',['nambar','number']],
  // misc household / objects
  ['ticket',['tikket','tikkat']],
  // 'kee' removed — collides with Tamil "கீ" (below/under)
  ['key',['key']],
  ['watch',['vaach','vaach']],
  ['book',['buk','book']],
  ['paper',['peppar','papar']],
  ['pen',['pen','pennu']],
  ['glass',['glaas','klaas']],
  ['table',['taebil','teabil']],
  ['chair',['saer','chair']],
  ['bed',['bed','bedu']],
  ['light',['lait','laitu']],
  ['bag',['paeg','baeg','baggu']],
  ['box',['baaks','box']],
  ['news',['nyoos','noos']],
  ['address',['adres','adress']],
  ['name',['nem','neem']],
  ['ID',['ai-di','aidee']],
  ['photo',['poto','footo']],
  ['color',['kalar','kular','colour']],
];

// Flatten into a fast lookup map: phoneticVariant → englishWord
const LOANWORD_MAP = {};
for (const [eng, variants] of LOANWORD_ENTRIES) {
  for (const v of variants) LOANWORD_MAP[v.toLowerCase()] = eng;
  LOANWORD_MAP[eng.toLowerCase()] = eng; // English form itself maps to canonical
}
const LOANWORD_KEYS_SORTED = Object.keys(LOANWORD_MAP).sort((a,b) => b.length - a.length);

// Common Tamil case-ending suffixes that may stick on loanword stems.
const CASE_SUFFIX = /^(s|ai|ae|aae|le|lae|ile|ilae|kku|kkae|odu|udan|aal|aalu|aalum|um|aa|ku|in|inu|leyo|loa|laam|kal|kale|kkaaga|kkaa|aa|um|aam|oda)$/i;

function applyLoanwords(text) {
  if (!text) return text;
  // Split on word boundaries while preserving separators
  return text.split(/(\b)/).map(token => {
    if (!/[a-z]/i.test(token)) return token;
    const lower = token.toLowerCase();
    // Exact match first
    if (LOANWORD_MAP[lower]) return LOANWORD_MAP[lower];
    // Prefix + Tamil case suffix — only for stems ≥ 5 chars to reduce false positives
    for (const k of LOANWORD_KEYS_SORTED) {
      if (k.length < 5) continue;                 // ⚠ short stems are exact-only
      if (lower.length <= k.length) continue;
      if (lower.startsWith(k)) {
        const suffix = lower.slice(k.length);
        if (CASE_SUFFIX.test(suffix)) {
          return LOANWORD_MAP[k] + suffix;
        }
      }
    }
    return token;
  }).join("");
}

// ── Local (instant) fallback: rule-based transliteration ─────────────
function transliterateLocal(text) {
  const script = detectScript(text);
  if (!script) return text;
  if (script === "tamil") return applyLoanwords(tamilToTanglish(text));
  return text; // other scripts pass through until Google romanizes them
}

// ── Google Translate transliteration endpoint (free, CORS-friendly) ──
// Returns natural Romanization for any Indic language. Better than any
// rule-based mapper because Google's ML handles word context.
const GOOGLE_LANG = {
  tamil: "ta", devanagari: "hi", telugu: "te",
  malayalam: "ml", kannada: "kn", bengali: "bn", gujarati: "gu"
};

async function googleRomanizeChunk(text, sl) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=en&dt=t&dt=rm&q=${encodeURIComponent(text)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("rate-limit");
  const data = await r.json();
  if (!Array.isArray(data?.[0])) throw new Error("no data");
  // Each chunk: [translation, original, null, romanization, ...]
  // We want index [3] (romanization). Fall back to [1] (original) if missing.
  const parts = data[0].map(s => (s?.[3] && s[3].trim()) ? s[3] : "");
  const joined = parts.join("").trim();
  if (!joined) throw new Error("empty");
  return joined;
}

// Split text into ≤500-char chunks at line boundaries to stay under Google's
// per-request size and keep formatting clean.
function chunkLyricsForRomanize(text, maxLen = 500) {
  const lines  = text.split("\n");
  const chunks = [];
  let buf = "";
  for (const line of lines) {
    const next = buf ? (buf + "\n" + line) : line;
    if (next.length > maxLen && buf) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function googleRomanize(text) {
  const script = detectScript(text);
  if (!script) return null;
  const sl = GOOGLE_LANG[script];
  if (!sl) return null;
  try {
    const chunks = chunkLyricsForRomanize(text);
    const out = [];
    for (const chunk of chunks) {
      const r = await googleRomanizeChunk(chunk, sl);
      out.push(r);
    }
    // Apply loanword post-processing — turns "saikkil/mottar/paent" → "cycle/motor/pant"
    const joined = out.join("\n");
    return script === "tamil" ? applyLoanwords(joined) : joined;
  } catch { return null; }
}

// Public API used by LiveSongView. Tries Google first; if it succeeds, returns
// that. Otherwise falls back to the local rule-based mapper (instant, offline).
async function transliterateBest(text) {
  const google = await googleRomanize(text);
  if (google) return { text: google, engine: "google" };
  return { text: transliterateLocal(text), engine: "local" };
}

// Synchronous fallback kept for back-compat in components that need an
// immediate value while Google's call is still in flight.
function transliterateToRoman(text) {
  return transliterateLocal(text);
}

// ── Detect section headers ([Verse], [Chorus], [Male], etc.) ─────────
const SECTION_PATTERNS = [
  { re: /^\[?\s*(male|man|boy)[\s:\]]*$/i,           tag: "male",    label: "Male" },
  { re: /^\[?\s*(female|woman|girl|lady)[\s:\]]*$/i, tag: "female",  label: "Female" },
  { re: /^\[?\s*(chorus|hook|refrain)[\s\d:\]]*$/i,  tag: "chorus",  label: "Chorus" },
  { re: /^\[?\s*(duet|both)[\s:\]]*$/i,              tag: "duet",    label: "Duet" },
  { re: /^\[?\s*(humming|hum+|aah+|ooh+)[\s:\]]*$/i, tag: "humming", label: "Humming" },
  { re: /^\[?\s*(verse|stanza)[\s\d:\]]*$/i,         tag: "verse",   label: "Verse" },
  { re: /^\[?\s*(pre-?chorus)[\s\d:\]]*$/i,          tag: "chorus",  label: "Pre-Chorus" },
  { re: /^\[?\s*(bridge)[\s\d:\]]*$/i,               tag: "verse",   label: "Bridge" },
  { re: /^\[?\s*(intro|prelude)[\s\d:\]]*$/i,        tag: "verse",   label: "Intro" },
  { re: /^\[?\s*(outro|ending)[\s\d:\]]*$/i,         tag: "verse",   label: "Outro" },
];

function matchSection(line) {
  const t = line.trim();
  for (const p of SECTION_PATTERNS) if (p.re.test(t)) return p;
  return null;
}

// ── Detect chord lines (e.g. "C G Am F") ─────────────────────────────
const CHORD_TOKEN = /^[A-G](#|b)?(m|maj|min|sus|dim|aug|add)?\d*(\/[A-G](#|b)?)?$/;
function isChordLine(line) {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length > 12) return false;
  const chords = tokens.filter(t => CHORD_TOKEN.test(t));
  return chords.length / tokens.length >= 0.75;
}

const TAG_BG = {
  male: "tag-male", female: "tag-female", chorus: "tag-chorus",
  duet: "tag-duet", humming: "tag-humming",
  verse: "bg-gray-700/40 text-gray-300 border border-gray-600/40",
};

// ── Parse lyrics into structured stanzas with tags + chord lines ─────
// Strategy:
//   1. If the source has explicit [Verse]/[Chorus]/[Male] markers, honor them.
//   2. Otherwise, apply heuristics: stanzas that repeat verbatim → Chorus;
//      remaining stanzas → numbered Verses.
// Detect inline tamil2lyrics-style markers like "Male : something" or "Chorus : ..."
// that appear at the start of a lyric line. Returns { tag, label, rest } or null.
const INLINE_MARKER_RE = /^\s*(Male|Female|Chorus|Duet|Both|Humming|Hummmm+|Whistling|Verse|Pre[- ]?Chorus|Bridge|Intro|Outro)\s*[:\-]\s*(.*)$/i;
function matchInlineMarker(line) {
  const m = line.match(INLINE_MARKER_RE);
  if (!m) return null;
  const word = m[1].toLowerCase().replace(/[^a-z]/g, "");
  const tagMap = { male:"male", female:"female", chorus:"chorus", duet:"duet", both:"duet",
                   humming:"humming", hummmm:"humming", whistling:"humming",
                   verse:"verse", prechorus:"chorus", bridge:"verse", intro:"verse", outro:"verse" };
  const tag = tagMap[word] || "verse";
  // Pretty label — capitalise first letter
  const label = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return { tag, label, rest: m[2].trim() };
}

function parseStructured(lyrics, opts = {}) {
  const skipAutoNumber = !!opts.skipAutoNumber;
  const rawStanzas = lyrics.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);

  const parsed = rawStanzas.map(stanza => {
    const rawLines = stanza.split("\n");
    let explicitSection = null;
    const lines = [];
    for (const raw of rawLines) {
      const sec = matchSection(raw);
      if (sec) { explicitSection = sec; continue; }
      if (!raw.trim()) { lines.push({ kind: "blank" }); continue; }
      // Try inline "Male : ..." marker — set the section AND keep the rest as a lyric line
      const inline = matchInlineMarker(raw);
      if (inline) {
        explicitSection = explicitSection || { tag: inline.tag, label: inline.label };
        if (inline.rest) lines.push({ kind: "lyric", text: inline.rest });
        continue;
      }
      if (isChordLine(raw)) { lines.push({ kind: "chord", text: raw.trim() }); continue; }
      lines.push({ kind: "lyric", text: raw });
    }
    const bodyKey = lines.filter(l => l.kind === "lyric").map(l => l.text.toLowerCase().trim().replace(/[.,!?;:'"]/g,"")).join("|");
    return { explicitSection, lines, bodyKey };
  });

  const counts = {};
  for (const p of parsed) if (p.bodyKey) counts[p.bodyKey] = (counts[p.bodyKey] || 0) + 1;

  let verseNum = 0;
  return parsed.map(p => {
    let section = p.explicitSection;
    if (!section && !skipAutoNumber) {
      if (p.bodyKey && counts[p.bodyKey] >= 2) {
        section = { tag: "chorus", label: "Chorus" };
      } else if (p.lines.some(l => l.kind === "lyric")) {
        verseNum += 1;
        section = { tag: "verse", label: `Verse ${verseNum}` };
      }
    }
    return { section, lines: p.lines };
  });
}

// ── Individual lyrics sources ─────────────────────────────────────────
const LYRIC_SOURCES = HAS_PROXY ? ["lrclib","tamil2lyrics"] : ["lrclib"];

// Route a fetch through our own Cloudflare Worker proxy (configured via
// the CORS_PROXY_URL build secret). The Worker fetches the target URL
// server-side and returns it with Access-Control-Allow-Origin: *.
async function fetchViaProxy(targetUrl) {
  if (!HAS_PROXY) throw new Error("No CORS proxy configured");
  const proxied = CORS_PROXY_URL + encodeURIComponent(targetUrl);
  const r = await fetch(proxied);
  if (!r.ok) throw new Error(`Proxy HTTP ${r.status}`);
  return r;
}

// 1. lrclib.net — free, no key, CORS, strong Indian + global coverage
async function fetchFromLrclib(artist, title, album = "") {
  const expected = { title, artist, album };
  const r1 = await fetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&album_name=${encodeURIComponent(album)}`);
  if (r1.ok) {
    const d = await r1.json();
    const lyr = d.plainLyrics || (d.syncedLyrics ? d.syncedLyrics.replace(/^\[[\d:\.]+\]\s*/gm,'') : null);
    if (lyr && lyr.length > 30 &&
        isPlausibleLyricsMatch(expected, { title: d.trackName, artist: d.artistName, album: d.albumName })) {
      return { lyrics: lyr, source: "lrclib" };
    }
  }
  const r2 = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(title+' '+artist)}`);
  if (!r2.ok) throw new Error("not found");
  const hits = await r2.json();
  // Score every hit that actually has lyrics and pick the best match instead
  // of blindly taking the first — lrclib's search is fuzzy, and a common
  // title easily surfaces a cover or an unrelated song (or the same title
  // from a different movie's soundtrack) ahead of the real one.
  const best = hits
    .filter(h => h.plainLyrics)
    .filter(h => isPlausibleLyricsMatch(expected, { title: h.trackName, artist: h.artistName, album: h.albumName }))
    .sort((a, b) => tokenOverlapScore(title, b.trackName || "") - tokenOverlapScore(title, a.trackName || ""))[0];
  if (!best) throw new Error("no plausible match");
  return { lyrics: best.plainLyrics, source: "lrclib" };
}

// 2. tamil2lyrics.com — human-curated Tanglish; goes through OUR proxy.
// Helper — search tamil2lyrics for a given query, return ALL /lyrics/ song
// URLs found (search relevance isn't always right — the caller tries them in
// order and verifies each before accepting one).
// IMPORTANT: only matches actual /lyrics/ URLs, NOT static assets (favicon, wp-content, etc.)
const T2L_LYRIC_URL_RE_ABS = /href="(https?:\/\/(?:www\.)?tamil2lyrics\.com\/lyrics\/[a-z0-9][a-z0-9-]+\/?)"/gi;
const T2L_LYRIC_URL_RE_REL = /href="(\/lyrics\/[a-z0-9][a-z0-9-]+\/?)"/gi;

async function _t2lSearch(query) {
  const searchUrl = `https://www.tamil2lyrics.com/?s=${encodeURIComponent(query)}`;
  const sr = await fetchViaProxy(searchUrl);
  const html = await sr.text();

  // Find all candidate URLs
  const candidates = [];
  let m;
  while ((m = T2L_LYRIC_URL_RE_ABS.exec(html)) !== null) candidates.push(m[1]);
  while ((m = T2L_LYRIC_URL_RE_REL.exec(html)) !== null) candidates.push("https://www.tamil2lyrics.com" + m[1]);
  T2L_LYRIC_URL_RE_ABS.lastIndex = 0;
  T2L_LYRIC_URL_RE_REL.lastIndex = 0;

  // Filter out anything that looks like a static asset or admin URL, then dedupe
  const isAsset = (u) => /\.(png|jpg|jpeg|gif|svg|webp|ico|css|js|woff|woff2|ttf|pdf)(\?|$)/i.test(u)
    || /\/(wp-content|wp-admin|wp-includes|feed|comments|category|tag|author|page)\//i.test(u);
  const real = candidates.filter((u, i, a) => !isAsset(u) && a.indexOf(u) === i);

  return { urls: real, html };
}

// Parse a single tamil2lyrics post page into {tanglishText, nativeText, pageTitle}.
function _t2lParsePage(pageHtml) {
  // Strip out <script>, <style>, ads, and other noise BEFORE turning HTML into text
  const stripNoiseTags = (html) => html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<ins[\s\S]*?<\/ins>/gi, "")              // adsbygoogle <ins> blocks
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "");

  // Convert HTML → plain text
  const toText = (html) => html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#?\w+;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();

  // Filter out ad-script leftovers, metadata, and section labels from each line
  const NOISE_LINE_RE = /^\s*(?:\(?adsbygoogle|window\.adsbygoogle|googletag|google_ad_|enable_page_level|English|Tanglish|Romanized|Translation|தமிழ்|Lyrics?\s*:?\s*$|Music\s*by\s*:?|Singer\s*:?|Lyricist\s*:?|Lyrics\s*by\s*:?|Whistling\s*:?|Year\s*:?|Movie\s*:?|Director\s*:?|Producer\s*:?|Cast\s*:?|Composer\s*:?|A[-+−–—]\s*$|Copy\s*$|Print\s*$|Share\s*$|Save\s*$|Bookmark\s*$|Font\s*Size\s*$|Increase\s*Font|Decrease\s*Font|Toggle\s*Font|Click\s*here|Read\s*more|Show\s*more|Show\s*less|(?:Male|Female|Duet|Both|Chorus|Verse|Pre[- ]?Chorus|Bridge|Intro|Outro)\s+Part\s*$)/i;
  // Boilerplate phrases that appear ANYWHERE in a line — kill the whole line
  const NOISE_CONTAINS_RE = /Song\s+Lyrics\s+from|Tamil\s+film\s+starring|in\s+a\s+lead\s+role|song\s+was\s+sung\s+by|music\s+is\s+composed\s+by|Lyrics\s+works?\s+are\s+penned|penned\s+by\s+lyricist|Lyrics?\s+penned\s+by|directed\s+by|produced\s+by|released\s+in\s+\d{4}|adsbygoogle|googletag|window\.googletag|©\s*\d{4}|All\s+rights\s+reserved|tamil2lyrics\.com|Subscribe\s+to|Follow\s+us/i;
  const isMostlyTamil  = (line) => {
    const t = (line.match(/[஀-௿]/g) || []).length;
    const l = (line.match(/[a-zA-Z]/g) || []).length;
    return t > l;
  };
  const cleanLines = (text) => text.split("\n").filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true; // keep blank lines for stanza breaks
    if (NOISE_LINE_RE.test(trimmed)) return false;
    if (NOISE_CONTAINS_RE.test(trimmed)) return false;
    return true;
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(pageHtml);
  const pageTitle  = titleMatch ? titleMatch[1].replace(/&amp;/g, "&").trim() : "";

  let tanglishText = "", nativeText = "";

  // Strategy A (current site redesign): English (Tanglish) and Tamil lyrics
  // are rendered as two sibling `data-t2l-lyrics-body` tab panels instead of
  // being split apart by header-marker text. Pull each panel directly by its
  // data attribute so we never touch the surrounding tabs/copy/print/share
  // button chrome — this is what broke when the site added those buttons.
  const t2lPanel = (tab) => {
    const openRe = new RegExp('<div[^>]*data-t2l-tab-panel="' + tab + '"[^>]*data-t2l-lyrics-body[^>]*>', "i");
    const om = openRe.exec(pageHtml);
    if (!om) return null;
    const rest = pageHtml.slice(om.index + om[0].length);
    const stopRes = [/<div[^>]*data-t2l-tab-panel="/i, /print:hidden/i, /<\/article/i];
    let end = rest.length;
    for (const re of stopRes) { const sm = re.exec(rest); if (sm && sm.index < end) end = sm.index; }
    return rest.slice(0, end);
  };
  const englishPanel = t2lPanel("english");
  const tamilPanel   = t2lPanel("tamil");
  if (englishPanel) tanglishText = cleanLines(toText(stripNoiseTags(englishPanel)));
  if (tamilPanel)   nativeText   = cleanLines(toText(stripNoiseTags(tamilPanel)));

  // Strategy B (fallback for older/other templates): guess a body wrapper,
  // then split on "English/Tanglish/Romanized" header-marker lines.
  if (!tanglishText) {
    let body = null;
    const wrappers = [
      /<div[^>]*class="[^"]*(?:entry-content|post-content|td-post-content|td_block_wrap|tdb-block-inner|article-content|content-area)[^"]*"[^>]*>([\s\S]*?)<\/article/i,
      /<div[^>]*class="[^"]*(?:entry-content|post-content)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<main[^>]*>([\s\S]*?)<\/main>/i,
    ];
    for (const re of wrappers) {
      const m = pageHtml.match(re);
      if (m && m[1] && m[1].length > 300) { body = m[1]; break; }
    }
    // Last resort: take everything between </header> and <footer>
    if (!body) {
      const m = pageHtml.match(/<\/header>([\s\S]*?)<footer/i);
      if (m && m[1] && m[1].length > 300) body = m[1];
    }
    if (!body) return { tanglishText: "", nativeText: "", pageTitle };

    const fullText = toText(stripNoiseTags(body));
    const sections = fullText.split(/^\s*(?:English|Tanglish|Romanized|Translation)\s*$/im);
    // Pick the section with most Latin chars = Tanglish; most Tamil chars = Native
    for (const sec of sections) {
      const latin = (sec.match(/[a-zA-Z]/g) || []).length;
      const tamil = (sec.match(/[஀-௿]/g) || []).length;
      if (latin > (tanglishText.match(/[a-zA-Z]/g)?.length || 0) && latin > tamil)  tanglishText = sec;
      if (tamil > (nativeText.match(/[஀-௿]/g)?.length   || 0) && tamil > latin)   nativeText   = sec;
    }
    // Fallback if no clear split — try filtering by line content
    if (!tanglishText) tanglishText = fullText.split("\n").filter(l => !isMostlyTamil(l)).join("\n");
    if (!nativeText)   nativeText   = fullText.split("\n").filter(l => isMostlyTamil(l) || !l.trim()).join("\n");

    tanglishText = cleanLines(tanglishText);
    nativeText   = cleanLines(nativeText);
  }

  return { tanglishText, nativeText, pageTitle };
}

async function fetchFromTamil2Lyrics(artist, title, album = "") {
  if (!HAS_PROXY) throw new Error("proxy not configured");

  // Try several query variants — search engines on WP can be picky.
  // Title-only goes FIRST: the site's WordPress search treats a multi-artist
  // string (e.g. "A & B") as required terms that rarely appear verbatim in a
  // post's credits, so the title+artist combo usually returns zero matches
  // and just burns an extra proxy round-trip before falling back anyway —
  // which under a slow network can push the whole lookup past its timeout.
  // The movie-qualified variant helps most when the same song title exists
  // in more than one film — it steers WP search toward the right post.
  const cleanTitle = title.replace(/\(.+?\)/g, "").trim();
  const queries = [
    cleanTitle,                                      // "Moongil Thottam"
    cleanTitle.split(/\s+/).slice(0, 2).join(" "),    // first 2 words
    album ? cleanTitle + " " + album : null,          // "Moongil Thottam <movie>"
    cleanTitle + (artist ? " " + artist : ""),        // "Moongil Thottam Shakthisree"
  ].filter((q, i, a) => q && a.indexOf(q) === i);     // dedupe + drop empties/nulls

  const expected = { title, artist, album };
  let lastHtmlPreview = "";
  let triedAny = false;

  // Cap total candidate page fetches across all query variants so a
  // stubborn mismatch can't burn an unbounded number of proxy round-trips.
  const MAX_CANDIDATES = 4;
  let attempts = 0;

  for (const q of queries) {
    if (attempts >= MAX_CANDIDATES) break;
    const { urls, html } = await _t2lSearch(q);
    if (!urls.length) { lastHtmlPreview = (html || "").slice(0, 200); continue; }

    for (const foundUrl of urls) {
      if (attempts >= MAX_CANDIDATES) break;
      attempts++;
      triedAny = true;

      const pr = await fetchViaProxy(foundUrl);
      const pageHtml = await pr.text();
      const { tanglishText, nativeText, pageTitle } = _t2lParsePage(pageHtml);

      const latinChars = (tanglishText.match(/[a-zA-Z]/g) || []).length;
      if (latinChars < 50 || tanglishText.length < 80) continue; // no usable Tanglish on this page

      // Verify the page is actually about the song we asked for before
      // trusting it — this is what stops a search engine merely ranking an
      // unrelated (or same-titled, wrong-movie) post first from silently
      // winning and getting cached.
      if (!isPlausibleLyricsMatch(expected, { title: pageTitle })) {
        console.warn("[tamil2lyrics] skipping mismatched page:", foundUrl, "→", pageTitle);
        continue;
      }

      return {
        lyrics:           tanglishText,         // primary display (Tanglish for tamil2lyrics)
        nativeLyrics:     nativeText || null,   // store native script separately so toggle works
        source:           "tamil2lyrics",
        alreadyRomanized: true,
        structured:       true,                 // signal to parser: skip auto-Verse-numbering
      };
    }
  }

  if (!triedAny) console.warn("[tamil2lyrics] search returned no lyric link. HTML preview:", lastHtmlPreview);
  throw new Error("not found");
}

// Hard cap each source so a slow / dead server never holds up the page.
// Mobile networks can stall any individual TLS handshake for 10+ seconds —
// without this, the user feels everything is slow even though Promise.any
// has already won.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)
    ),
  ]);
}

// Race available sources — first with real lyrics wins. Source preference
// comes from user settings; default is "tamil2lyrics-first" (try it first;
// fall back to lrclib if it fails).
async function fetchLyricsRace(artist, title, album = "") {
  const norm = normalizeTitle(title);
  const T_DIRECT = 12000;
  const T_PROXY  = 18000;
  const wrap = (p, label, ms) => withTimeout(p, ms, label).catch(e => {
    console.warn(`[lyrics] ${label} failed: ${e.message}`);
    throw e;
  });

  const pref = getSettings().lyricsSource || "tamil2lyrics-first";

  // Sequential mode — try preferred source, fall back if it fails
  const trySequential = async (first, firstName, firstTimeout, second, secondName, secondTimeout) => {
    try {
      return await wrap(first, firstName, firstTimeout);
    } catch {
      try { return await wrap(second, secondName, secondTimeout); }
      catch { return null; }
    }
  };

  if (pref === "tamil2lyrics-only" && HAS_PROXY) {
    try { return await wrap(fetchFromTamil2Lyrics(artist, norm, album), "tamil2lyrics", T_PROXY); }
    catch {
      try { return await wrap(fetchFromTamil2Lyrics("", norm, album), "tamil2lyrics-2", T_PROXY); }
      catch { return null; }
    }
  }

  if (pref === "lrclib-only" || !HAS_PROXY) {
    try { return await wrap(fetchFromLrclib(artist, norm, album), "lrclib", T_DIRECT); }
    catch {
      try { return await wrap(fetchFromLrclib("", norm, album), "lrclib-2", T_DIRECT); }
      catch { return null; }
    }
  }

  if (pref === "lrclib-first" && HAS_PROXY) {
    return await trySequential(
      fetchFromLrclib      (artist, norm, album), "lrclib",       T_DIRECT,
      fetchFromTamil2Lyrics(artist, norm, album), "tamil2lyrics", T_PROXY,
    );
  }

  // Default: tamil2lyrics-first — try tamil2lyrics, fall back to lrclib
  if (HAS_PROXY) {
    return await trySequential(
      fetchFromTamil2Lyrics(artist, norm, album), "tamil2lyrics", T_PROXY,
      fetchFromLrclib      (artist, norm, album), "lrclib",       T_DIRECT,
    );
  }
  // Fallback if no proxy
  try { return await wrap(fetchFromLrclib(artist, norm, album), "lrclib", T_DIRECT); } catch { return null; }
}

// Fetch explicitly from one named source (manual switcher in UI)
async function fetchLyricsFromSource(artist, title, source, album = "") {
  const norm = normalizeTitle(title);
  try {
    if (source === "lrclib")       return await fetchFromLrclib(artist, norm, album);
    if (source === "tamil2lyrics") return await fetchFromTamil2Lyrics(artist, norm, album);
  } catch {}
  return null;
}

function ugLink(title, artist)    { return `https://www.ultimate-guitar.com/search.php?title=${encodeURIComponent(title)}&performer=${encodeURIComponent(artist)}`; }
function torrinsLink(title)        { return `https://www.torrins.com/guitar-lessons/?s=${encodeURIComponent(title)}`; }
function geniusLink(title, artist) { return `https://genius.com/search?q=${encodeURIComponent(title + ' ' + artist)}`; }

// Chord-availability check removed — CORS proxies are unreliable on many
// networks. The ChordButton now just links out to chord sites unconditionally.

// ─── LocalStorage ─────────────────────────────────────────────────────
const LS = { get:(k,d)=>{ try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch{return d} }, set:(k,v)=>{ try{localStorage.setItem(k,JSON.stringify(v))}catch{} } };
const getUsers          = ()    => LS.get("jb_users",[]);
const saveUsers         = u     => LS.set("jb_users",u);
const getSession        = ()    => LS.get("jb_session",null);
const saveSession       = s     => LS.set("jb_session",s);
const getSettings       = ()    => LS.get("jb_settings", { lyricsSource: "tamil2lyrics-first" });
const saveSettings      = s     => LS.set("jb_settings", s);
const getUserFolders    = uid   => LS.get(`jb_folders_${uid}`,[]);
const saveUserFolders   = (u,f) => LS.set(`jb_folders_${u}`,f);
const getSharedFolders  = ()    => LS.get("jb_shared",{});
const saveSharedFolders = s     => LS.set("jb_shared",s);

// ── URL-based folder sharing — works across devices/browsers ──────────
// The link itself carries the folder data (base64-encoded JSON in ?share=).
// This sidesteps localStorage (which is per-device) so a friend can paste
// the link in their browser and import — no backend required.
function _b64encode(bytesOrStr) {
  // bytesOrStr is either a Uint8Array (gzip) or a UTF-8 string (legacy path)
  let binary;
  if (typeof bytesOrStr === "string") {
    binary = unescape(encodeURIComponent(bytesOrStr));
  } else {
    binary = "";
    for (let i = 0; i < bytesOrStr.length; i++) binary += String.fromCharCode(bytesOrStr[i]);
  }
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

function _b64decodeBytes(b64) {
  const padded = b64.replace(/-/g,"+").replace(/_/g,"/")
                    + "===".slice(0, (4 - b64.length % 4) % 4);
  const binary = atob(padded);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Gzip-compress a JSON string and return URL-safe base64 (~60-75% smaller).
// Uses the browser-native CompressionStream API. Falls back to plain base64
// if the API isn't available (very old browsers).
async function _gzipEncode(json) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return _b64encode(new Uint8Array(buffer));
  } catch { return null; }
}

async function _gzipDecode(b64) {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const bytes  = _b64decodeBytes(b64);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return new TextDecoder().decode(buffer);
  } catch { return null; }
}

// Generate a short broadcast-room ID — used to scope a Supabase Realtime
// channel between a folder owner (broadcaster) and the people they share with.
function newBroadcastRoom() {
  return (window.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2,10)))
    .replace(/-/g, "").slice(0, 16);
}

// Short share token — 12 alphanumeric chars, ~70 bits of entropy
// (no collisions expected for any realistic user base)
function newShareToken() {
  const raw = (window.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2,15)));
  return raw.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
}

// Server-side share — store the full folder payload in Supabase's folders
// row, return a short token. Recipient fetches by token. Drops the URL from
// 5KB+ down to ~70 characters.
async function publishShareToServer(folder, user, songs) {
  if (!HAS_SUPABASE || !folder.id) return null;
  const token = folder.shareCode || newShareToken();

  // Re-read the folder's current songs rather than trusting the `songs`
  // passed in — this write replaces the whole `songs` column, and the
  // caller's copy can be stale relative to a song someone added via a
  // "Request Songs" link moments ago. Falls back to the passed-in list only
  // if the read fails, so sharing still works rather than hard-erroring.
  const { data: current } = await sb.from("folders")
    .select("songs").eq("id", folder.id).eq("user_id", user.id).maybeSingle();
  const baseSongs = current?.songs
    ? current.songs.map(s => { const c = { ...s }; delete c._shareLyrics; return c; })
    : songs;

  // Enrich each song with its cached lyrics — stored inline on the song
  // so the recipient gets them in a single query.
  const enrichedSongs = baseSongs.map(s => {
    if (s.type !== "live") return s;
    const cached = getCachedLyrics(s.id);
    if (!cached?.lyrics) return s;
    return { ...s, _shareLyrics: {
      lyrics:           cached.lyrics,
      source:           cached.source,
      googleRoman:      cached.googleRoman || undefined,
      nativeLyrics:     cached.nativeLyrics || undefined,
      alreadyRomanized: cached.alreadyRomanized || undefined,
      structured:       cached.structured || undefined,
    }};
  });

  const room = folder.broadcastRoom || newBroadcastRoom();
  const { error } = await sb.from("folders").update({
    share_token:         token,
    songs:               enrichedSongs,
    original_owner_id:   user.id,
    original_owner_name: user.username,
    broadcast_room:      room,
  }).eq("id", folder.id).eq("user_id", user.id);
  if (error) { console.error("[share-publish]", error); return null; }
  return token;
}

async function fetchShareByToken(token) {
  if (!HAS_SUPABASE || !token) return null;
  const { data, error } = await sb.from("folders")
    .select("*").eq("share_token", token).limit(1).maybeSingle();
  if (error || !data) return null;

  const rawSongs = data.songs || [];
  const songs = rawSongs.map(s => { const c={...s}; delete c._shareLyrics; return c; });
  const lyricsCache = {};
  for (const s of rawSongs) if (s._shareLyrics?.lyrics) lyricsCache[s.id] = s._shareLyrics;

  return {
    v: 4,
    ownerName:     data.original_owner_name || "Someone",
    ownerId:       data.original_owner_id || data.user_id,
    folderName:    data.name,
    broadcastRoom: data.broadcast_room,
    songs,
    lyricsCache: Object.keys(lyricsCache).length ? lyricsCache : undefined,
  };
}

// ─── Audience song requests ────────────────────────────────────────────
// A separate, stable token (distinct from share_token) that lets anyone with
// the link add songs directly into the LIVE folder — no account needed.
// Requires the `request_token` column + matching RLS policies (see README).
async function fetchFolderByRequestToken(token) {
  if (!HAS_SUPABASE || !token) return null;
  const { data, error } = await sb.from("folders")
    .select("id,name,songs").eq("request_token", token).limit(1).maybeSingle();
  if (error || !data) return null;
  return { id: data.id, name: data.name, songs: data.songs || [] };
}

// Read-modify-write append. Two people requesting in the same instant could
// race and clobber each other's addition — acceptable for a casual jam-session
// tool; not meant to be a high-concurrency queue.
async function addSongViaRequestToken(token, song) {
  if (!HAS_SUPABASE || !token) return { ok: false, error: "Not configured" };
  const { data, error: readErr } = await sb.from("folders")
    .select("songs").eq("request_token", token).limit(1).maybeSingle();
  if (readErr || !data) return { ok: false, error: "Request link not found" };
  const songs = data.songs || [];
  if (songs.some(s => s.id === song.id)) return { ok: true, alreadyAdded: true };
  const { error: writeErr } = await sb.from("folders")
    .update({ songs: [...songs, song] }).eq("request_token", token);
  if (writeErr) return { ok: false, error: writeErr.message };
  return { ok: true };
}

// Casts (or retracts, direction=-1) an upvote for a song already in the
// queue, then re-sorts pending songs by vote count — highest first, ties
// keeping their existing relative order (stable sort) — so upvoted songs
// actually move to the top of the real session queue, not just a display
// list. Completed songs stay put at the end either way. Same read-then-write
// trade-off as addSongViaRequestToken above: fine for a casual jam session,
// not built to survive many people voting in the exact same instant.
async function voteForSong(token, songId, direction) {
  if (!HAS_SUPABASE || !token) return { ok: false, error: "Not configured" };
  const { data, error: readErr } = await sb.from("folders")
    .select("songs").eq("request_token", token).limit(1).maybeSingle();
  if (readErr || !data) return { ok: false, error: "Request link not found" };
  const songs = data.songs || [];
  const idx = songs.findIndex(s => s.id === songId);
  if (idx === -1) return { ok: false, error: "Song not found" };

  const newVotes = Math.max(0, (songs[idx].votes || 0) + direction);
  const merged = songs.map(s => s.id === songId ? { ...s, votes: newVotes } : s);
  const pending   = merged.filter(s => !s.completed);
  const completed = merged.filter(s => s.completed);
  pending.sort((a, b) => (b.votes || 0) - (a.votes || 0));

  const { error: writeErr } = await sb.from("folders")
    .update({ songs: [...pending, ...completed] }).eq("request_token", token);
  if (writeErr) return { ok: false, error: writeErr.message };
  return { ok: true, votes: newVotes };
}

const SHARE_URL_MAX = 60000;

async function encodeShareLink(folder, user, songs) {
  const base = window.location.origin + window.location.pathname;

  // Preferred path: store the share payload in Supabase, URL is just a token.
  // Keeps URLs under 100 chars regardless of folder size.
  if (HAS_SUPABASE && folder.id) {
    const token = await publishShareToServer(folder, user, songs);
    if (token) return { url: `${base}?share=${token}`, shareCode: token };
  }

  // Fallback path: encode the entire payload in the URL (legacy, gzip+base64)
  const songStubs = songs.map(s => ({
    id:       s.id,
    type:     s.type || "live",
    title:    s.title,
    artist:   s.artist || s.singer || "",
    album:    s.album  || s.movie  || "",
    cover:    s.cover  || "",
    language: s.language || "",
  }));

  // Collect every cached lyrics blob locally so recipient sees them instantly.
  const lyricsCache = {};
  for (const s of songs) {
    if (s.type !== "live") continue;
    const cached = getCachedLyrics(s.id);
    if (cached?.lyrics) {
      lyricsCache[s.id] = {
        lyrics:           cached.lyrics,
        source:           cached.source,
        googleRoman:      cached.googleRoman || undefined,
        nativeLyrics:     cached.nativeLyrics || undefined,
        alreadyRomanized: cached.alreadyRomanized || undefined,
        structured:       cached.structured || undefined,
      };
    }
  }

  const broadcastRoom = folder.broadcastRoom || newBroadcastRoom();
  const payload = {
    v: 3,
    ownerName: user.username,
    ownerId:   user.id,
    folderName: folder.name,
    broadcastRoom,
    songs: songStubs,
    lyricsCache: Object.keys(lyricsCache).length ? lyricsCache : undefined,
  };

  const build = async (data) => {
    const json = JSON.stringify(data);
    const gz   = await _gzipEncode(json);
    return gz ? `${base}?share=z${gz}` : `${base}?share=${_b64encode(json)}`;
  };

  let url = await build(payload);
  if (url.length > SHARE_URL_MAX && payload.lyricsCache) {
    // Drop the heavy lyrics cache and re-encode
    const lite = { ...payload, lyricsCache: undefined };
    url = await build(lite);
    console.warn(`[share] URL too long with cache — sharing without embedded lyrics (recipient will re-fetch).`);
  }
  return { url, shareCode: null };
}

async function decodeShareFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("share");
  if (!raw) return null;

  // Short alphanumeric token? Try fetching from Supabase first.
  if (raw.length <= 24 && /^[a-zA-Z0-9_-]+$/.test(raw) && !raw.startsWith("z")) {
    const fromServer = await fetchShareByToken(raw);
    if (fromServer) return fromServer;
    // fall through to legacy decode if not found
  }

  try {
    let json;
    if (raw.startsWith("z")) {
      json = await _gzipDecode(raw.slice(1));
      if (!json) return null;
    } else {
      const padded = raw.replace(/-/g,"+").replace(/_/g,"/")
                        + "===".slice(0, (4 - raw.length % 4) % 4);
      json = decodeURIComponent(escape(atob(padded)));
    }
    return JSON.parse(json);
  } catch { return null; }
}

function clearShareFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("share");
  window.history.replaceState({}, "", url.toString());
}
const getSongCache      = ()    => LS.get("jb_songcache",{});
const saveSongCache     = c     => LS.set("jb_songcache",c);
const getLyricsCache    = ()    => LS.get("jb_lyricscache",{});
const saveLyricsCache   = c     => LS.set("jb_lyricscache",c);

function getCachedLyrics(songId) {
  return getLyricsCache()[songId] || null; // {lyrics, source}
}
function setCachedLyrics(songId, data) {
  const c = getLyricsCache();
  c[songId] = data;
  saveLyricsCache(c);
}

// ─── One-way song archive ──────────────────────────────────────────────
// Seed for a future self-hosted song database: every song that gets lyrics
// (from search or custom entry) is upserted into Supabase's `song_archive`
// table, deduped by title+artist+movie. Writing has no cap on song count —
// a DB-side trigger silently stops inserts once the table hits 100 rows.
// Reading is scoped narrowly: only shared/imported folders consult it (see
// fetchArchivedLyrics below), never general search or normal folder use.
// See README for the SQL to create the table + read policy.
// Same-song match by name+artist+movie (not id) — different sources
// (Spotify/JioSaavn/iTunes) mint different ids for the same actual song.
function songMatchKey(s) {
  return [s.title, s.artist || s.singer, s.album || s.movie]
    .map(v => (v || "").trim().toLowerCase()).join("|");
}
async function archiveSong(song, { native, roman, source } = {}) {
  if (!HAS_SUPABASE || !song?.title) return;
  if (!native && !roman) return;
  const dedupe_key = songMatchKey(song);
  if (dedupe_key === "||") return;
  try {
    // Supabase's client doesn't throw on a REST-level rejection (RLS denial,
    // bad column, etc.) — it resolves normally with `error` populated, so
    // that has to be checked explicitly or failures go completely silent.
    const { error } = await sb.from("song_archive").upsert({
      dedupe_key,
      title:         song.title,
      artist:        song.artist || song.singer || "",
      movie:         song.album  || song.movie  || "",
      source:        source || "unknown",
      lyrics_native: native || null,
      lyrics_roman:  roman  || null,
      updated_at:    new Date().toISOString(),
    }, { onConflict: "dedupe_key" });
    if (error) console.warn("[archive]", error.code, error.message);
  } catch (e) {
    console.warn("[archive]", e.message);
  }
}
// Split native vs. romanized text out of a lyrics-cache blob for archiving.
function archiveFromLyricsData(song, data) {
  archiveSong(song, {
    source: data.source,
    native: data.nativeLyrics || (!data.alreadyRomanized && detectScript(data.lyrics) ? data.lyrics : null),
    roman:  data.alreadyRomanized ? data.lyrics : (data.googleRoman || (!detectScript(data.lyrics) ? data.lyrics : null)),
  });
}

// Backfills the archive for songs that already carry custom lyrics — either
// fully custom entries (type "custom") or a live song with user-edited
// lyrics attached. preFetchLyrics/preFetchFolderSongs deliberately skip
// these (there's nothing to fetch), so without this they'd only ever reach
// the archive at the exact moment someone hits Save in the lyrics editor —
// never on a plain folder load/reopen, unlike every other song type.
function archiveCustomSongs(songs) {
  if (!Array.isArray(songs)) return;
  for (const s of songs) {
    if (!s || (!s.customLyrics && !s.customLyricsRoman)) continue;
    archiveSong(s, { native: s.customLyrics, roman: s.customLyricsRoman, source: "custom" });
  }
}

// One batched lookup against song_archive for a set of songs — used only
// when importing a shared/request-linked folder. Deliberately checks EVERY
// live song, including ones that already got a lyrics snapshot embedded in
// the share payload: that snapshot was frozen at the moment the share link
// was first generated, so if the sharer has edited lyrics since, the
// archive (kept current on every edit) is the fresher, authoritative
// source and should win — a song with a hit here never touches the live
// Spotify/JioSaavn/iTunes/lrclib/tamil2lyrics chain at all either way.
async function fillLyricsFromArchive(songs) {
  if (!HAS_SUPABASE || !Array.isArray(songs) || !songs.length) return;
  const targets = songs.filter(s => s && s.type === "live" && !s.customLyrics);
  if (!targets.length) return;
  const keyToSongs = {};
  for (const s of targets) {
    const k = songMatchKey(s);
    (keyToSongs[k] ||= []).push(s);
  }
  try {
    const { data, error } = await sb.from("song_archive")
      .select("dedupe_key,source,lyrics_native,lyrics_roman")
      .in("dedupe_key", Object.keys(keyToSongs));
    if (error || !data) return;
    for (const row of data) {
      const matches = keyToSongs[row.dedupe_key];
      if (!matches) continue;
      const cacheEntry = {
        lyrics:           row.lyrics_native || row.lyrics_roman,
        source:           row.source || "archive",
        nativeLyrics:     row.lyrics_native || undefined,
        googleRoman:      row.lyrics_native ? (row.lyrics_roman || undefined) : undefined,
        alreadyRomanized: !row.lyrics_native && !!row.lyrics_roman,
      };
      for (const s of matches) setCachedLyrics(s.id, cacheEntry);
    }
  } catch (e) {
    console.warn("[archive-read]", e.message);
  }
}
// Pre-fetch lyrics silently and store in cache. Called when a song is added
// to a folder, when a folder is loaded on app start, and when a shared folder
// is imported. Also pre-caches the Google romanization so the user sees
// "Smart" Tanglish instantly the first time they open the song.
async function preFetchLyrics(song) {
  if (!song || song.type !== "live") return;             // skip custom songs (they have lyrics embedded)
  if (song.customLyrics) return;                          // already user-edited
  const existing = getCachedLyrics(song.id);
  // Skip the fetch only if BOTH lyrics + romanization are already cached
  if (existing && (existing.googleRoman || existing.alreadyRomanized || !detectScript(existing.lyrics))) {
    archiveFromLyricsData(song, existing);
    return;
  }

  try {
    let data = existing;
    if (!data) {
      data = await fetchLyricsRace(song.artist, song.title, song.album);
      if (!data) return;
      setCachedLyrics(song.id, data);
    }
    // Also pre-fetch romanization for native-script lyrics (best-effort)
    if (!data.alreadyRomanized && !data.googleRoman) {
      const native = detectScript(data.lyrics);
      if (native) {
        const roman = await googleRomanize(data.lyrics);
        if (roman) { data = { ...data, googleRoman: roman }; setCachedLyrics(song.id, data); }
      }
    }
    archiveFromLyricsData(song, data);
  } catch (e) {
    console.warn("[prefetch]", song.title, "→", e.message);
  }
}

// Batch pre-fetch every song in a list, with concurrency limit so we don't
// flood the network when a folder has 50+ songs. Includes already-cached
// songs deliberately, not just uncached ones: preFetchLyrics's own fast
// path (below) never re-fetches a cached song's lyrics from a live source —
// it only archives it to song_archive, a local no-network operation. That's
// what keeps a shared folder's source stable *and* lets already-used songs
// still get backfilled into the archive when a folder is simply reopened.
async function preFetchFolderSongs(songs, concurrency = 5) {
  if (!Array.isArray(songs) || !songs.length) return;
  const queue = songs.filter(s => s && s.type === "live" && !s.customLyrics);
  if (!queue.length) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (cursor < queue.length) {
      const s = queue[cursor++];
      await preFetchLyrics(s);
    }
  });
  await Promise.all(workers);
}

// ─── Unified DB adapter — Supabase if configured, else localStorage ───
// Folder shape: { id, name, songs: [...full song objects...], shareCode }
const newFolderId = () => (window.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random().toString(36).slice(2,8));

const db = {
  async signUp(username, password) {
    let session;
    if (HAS_SUPABASE) {
      const email = usernameToEmail(username);
      const { data, error } = await sb.auth.signUp({
        email, password, options: { data: { username } }
      });
      if (error) throw new Error(error.message);
      if (!data.session) {
        const { data: si, error: sie } = await sb.auth.signInWithPassword({ email, password });
        if (sie) throw new Error("Account created. Please sign in.");
        session = { id: si.user.id, username, color: avatarColor(username) };
      } else {
        session = { id: data.user.id, username, color: avatarColor(username) };
      }
    } else {
      const users = getUsers();
      if (users.find(x => x.username.toLowerCase() === username.toLowerCase()))
        throw new Error("Username already taken on this device.");
      const newId = Date.now();
      const color = avatarColor(username);
      saveUsers([...users, { id: newId, username, password, color }]);
      saveUserFolders(newId, []);
      saveSession({ id: newId, username, color });
      session = { id: newId, username, color };
    }
    // Default starter folder — non-blocking; signup should never fail because of this
    this.createFolder(session, "Vibe List").catch(e => console.warn("Default folder skipped:", e?.message || e));
    return session;
  },

  async signIn(username, password) {
    if (HAS_SUPABASE) {
      const email = usernameToEmail(username);
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        if (/invalid/i.test(error.message)) throw new Error("Wrong username or password.");
        throw new Error(error.message);
      }
      return { id: data.user.id, username, color: avatarColor(username) };
    }
    const users = getUsers();
    if (users.length === 0) throw new Error("No accounts on this device yet. Create one below.");
    const match = users.find(x => x.username.toLowerCase() === username.toLowerCase());
    if (!match) throw new Error(`No account named "${username}" on this device.`);
    if (match.password !== password) throw new Error("Wrong password.");
    const sess = { id: match.id, username: match.username, color: match.color };
    saveSession(sess);
    return sess;
  },

  async signOut() {
    if (HAS_SUPABASE) { try { await sb.auth.signOut(); } catch {} }
    saveSession(null);
  },

  async restoreSession() {
    if (HAS_SUPABASE) {
      const { data } = await sb.auth.getSession();
      if (!data.session) return null;
      const u = data.session.user;
      const username = u.user_metadata?.username || (u.email || "").split("@")[0];
      return { id: u.id, username, color: avatarColor(username) };
    }
    return getSession();
  },

  async getFolders(user) {
    if (HAS_SUPABASE) {
      const { data, error } = await sb.from("folders")
        .select("*").eq("user_id", user.id).order("created_at");
      if (error) { console.error(error); return []; }
      return data.map(r => ({
        id: r.id, name: r.name,
        // Strip _shareLyrics from songs — only needed during share fetch.
        songs: (r.songs || []).map(s => { const c={...s}; delete c._shareLyrics; return c; }),
        shareCode:         r.share_token        || null,
        requestToken:      r.request_token      || null,
        broadcastRoom:     r.broadcast_room     || null,
        originalOwnerId:   r.original_owner_id  || null,
        originalOwnerName: r.original_owner_name|| null,
      }));
    }
    const fs = getUserFolders(user.id);
    return fs.map(f => {
      if (f.songs) return f;
      const songs = (f.songIds || []).map(id => resolveSongById(id)).filter(Boolean);
      return { id: f.id, name: f.name, songs, shareCode: f.shareCode || null };
    });
  },

  // Pure read, no write — used by the manual "Refresh" button so someone
  // can pick up songs added via a Request Songs link (or from another
  // device) without reloading the whole app and losing their place.
  async getFolderSongs(user, folderId) {
    if (!HAS_SUPABASE || user?.isGuest) return null;
    const { data } = await sb.from("folders")
      .select("songs").eq("id", folderId).eq("user_id", user.id).maybeSingle();
    if (!data?.songs) return null;
    return data.songs.map(s => { const c = { ...s }; delete c._shareLyrics; return c; });
  },

  async createFolder(user, name) {
    if (user?.isGuest) {
      // Guests get an in-memory folder; nothing persisted.
      return { id: newFolderId(), name, songs: [], shareCode: null };
    }
    if (HAS_SUPABASE) {
      const { data, error } = await sb.from("folders")
        .insert({ user_id: user.id, name, songs: [] })
        .select().single();
      if (error) throw error;
      return { id: data.id, name: data.name, songs: data.songs, shareCode: null };
    }
    const f = { id: newFolderId(), name, songs: [], shareCode: null };
    const all = getUserFolders(user.id);
    saveUserFolders(user.id, [...all, f]);
    return f;
  },

  async updateFolder(user, folder) {
    if (user?.isGuest) return; // no-op for guests
    if (HAS_SUPABASE) {
      const patch = {
        name:                 folder.name,
        songs:                folder.songs,
        share_token:          folder.shareCode || null,
        request_token:        folder.requestToken || null,
        broadcast_room:       folder.broadcastRoom     || null,
        original_owner_id:    folder.originalOwnerId   || null,
        original_owner_name:  folder.originalOwnerName || null,
      };
      const { error } = await sb.from("folders")
        .update(patch)
        .eq("id", folder.id).eq("user_id", user.id);
      if (error) console.error(error);
      return;
    }
    const all = getUserFolders(user.id);
    saveUserFolders(user.id, all.map(x => x.id === folder.id ? folder : x));
  },

  // Applies `mutate` to a folder's *current* song list — fetched fresh from
  // the DB right before writing, not trusted from this device's possibly
  // stale local state — then persists and returns the resulting folder.
  //
  // Why this exists: db.updateFolder always overwrites the whole `songs`
  // column with whatever it's given. A song can land in that column from a
  // writer this device doesn't know about yet — an audience member adding
  // one via a "Request Songs" link hits Supabase directly, bypassing this
  // device's state entirely. If this device then saves ANY change (even an
  // unrelated rename), a blind write from its stale local `songs` silently
  // deletes whatever that other writer added. Re-reading immediately before
  // every write closes that gap; it doesn't fully eliminate races between
  // two simultaneous writers, but that's an acceptable, much narrower risk
  // for a casual jam-session tool (same trade-off already documented for
  // the request-link feature itself).
  async mutateFolderSongs(user, folder, mutate) {
    let base = folder.songs;
    if (HAS_SUPABASE && !user?.isGuest) {
      const { data } = await sb.from("folders")
        .select("songs").eq("id", folder.id).eq("user_id", user.id).maybeSingle();
      if (data?.songs) base = data.songs.map(s => { const c = { ...s }; delete c._shareLyrics; return c; });
    }
    const updated = { ...folder, songs: mutate(base) };
    await this.updateFolder(user, updated);
    return updated;
  },

  async deleteFolder(user, folderId) {
    if (user?.isGuest) return; // no-op for guests
    if (HAS_SUPABASE) {
      await sb.from("folders").delete().eq("id", folderId).eq("user_id", user.id);
      return;
    }
    const all = getUserFolders(user.id);
    saveUserFolders(user.id, all.filter(x => x.id !== folderId));
  },
};

function cacheSong(song) {
  if (song.type !== "live") return;
  const c = getSongCache();
  c[song.id] = song;
  saveSongCache(c);
}
function getCachedSong(id) {
  const c = getSongCache();
  return c[id] || null;
}
function resolveSongById(id) {
  if (String(id).startsWith("c")) return CURATED.find(s => s.id === id) || null;
  return getCachedSong(id);
}

function avatarColor(u) {
  let h=0; for(let i=0;i<u.length;i++) h=(h*31+u.charCodeAt(i))&0xffffffff;
  return AVATAR_COLORS[Math.abs(h)%AVATAR_COLORS.length];
}
function genCode() { return Math.random().toString(36).substring(2,8).toUpperCase(); }

// One-time migration: strip demo users + curated song references from prior versions.
// Wrapped in a single try/catch — must NEVER throw at module load, would block React mount.
(function migrate(){
  try {
    const users = getUsers();
    const cleaned = users.filter(u => !((u.id===1||u.id===2) && u.password==="demo123"));
    if (cleaned.length !== users.length) {
      saveUsers(cleaned);
      try { localStorage.removeItem("jb_folders_1"); } catch {}
      try { localStorage.removeItem("jb_folders_2"); } catch {}
    }
    for (const u of cleaned) {
      const fs = getUserFolders(u.id);
      if (!Array.isArray(fs)) continue;
      let dirty = false;
      const cleanedFs = fs.map(f => {
        if (!f) return f;
        // Old shape used `songIds`; new shape uses `songs`. Handle both.
        if (Array.isArray(f.songIds)) {
          const newIds = f.songIds.filter(id => !String(id).startsWith("c"));
          if (newIds.length !== f.songIds.length) dirty = true;
          return { ...f, songIds: newIds };
        }
        if (Array.isArray(f.songs)) {
          const newSongs = f.songs.filter(s => s && !String(s.id || "").startsWith("c"));
          if (newSongs.length !== f.songs.length) dirty = true;
          return { ...f, songs: newSongs };
        }
        return f;
      });
      if (dirty) saveUserFolders(u.id, cleanedFs);
    }
  } catch (err) {
    console.warn("[JamBook migrate] skipped due to error:", err);
  }
})();

// ─── Toast ────────────────────────────────────────────────────────────
function useIsMobile(breakpoint = 768) {
  const [m, setM] = React.useState(() =>
    typeof window !== "undefined" && window.innerWidth < breakpoint
  );
  React.useEffect(() => {
    const fn = () => setM(window.innerWidth < breakpoint);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, [breakpoint]);
  return m;
}

function useToast() {
  const [msg, setMsg] = React.useState(null);
  const show = (m,d=2500) => { setMsg(m); setTimeout(()=>setMsg(null),d); };
  return [msg, show];
}

// ─── Atoms ────────────────────────────────────────────────────────────
function Tag({type}) { const c=TAG_CONFIG[type]||TAG_CONFIG.chorus; return <span className={`chord-badge text-xs px-2 py-0.5 rounded-full font-semibold ${c.class}`}>{c.label}</span>; }
function ChordBadge({chord}) { return <span className="chord-badge text-xs font-bold text-violet-400 bg-violet-900/30 border border-violet-700/40 px-2 py-0.5 rounded mr-1">{chord}</span>; }
function Avatar({username,size=36}) {
  return <div className="avatar" style={{background:avatarColor(username),width:size,height:size,fontSize:size*.38}}>{username.charAt(0).toUpperCase()}</div>;
}
function Spinner() {
  return <div className="flex items-center justify-center py-12"><div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" /></div>;
}

// ─── Auth ─────────────────────────────────────────────────────────────
function AuthPage({onLogin}) {
  const [mode,setMode]         = React.useState("login");
  const [username,setUsername] = React.useState("");
  const [password,setPassword] = React.useState("");
  const [error,setError]       = React.useState("");

  const [busy, setBusy] = React.useState(false);

  const submit = async e => {
    e.preventDefault(); setError("");
    const u = username.trim();
    const p = password;
    if (!u) { setError("Please enter your username."); return; }
    if (!p) { setError("Please enter your password."); return; }
    if (mode === "register") {
      if (u.length < 2) { setError("Username must be at least 2 characters."); return; }
      if (p.length < 4) { setError("Password must be at least 4 characters."); return; }
    }

    setBusy(true);
    try {
      const sess = mode === "login"
        ? await db.signIn(u, p)
        : await db.signUp(u, p);
      onLogin(sess);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-bg min-h-screen flex items-center justify-center px-4">
      <div className="auth-card rounded-2xl p-8 w-full max-w-sm shadow-2xl">
        <div className="text-center mb-8">
          <div className="text-4xl mb-2">🎸</div>
          <h1 className="text-2xl font-bold text-white">JamBook</h1>
          <p className="text-gray-500 text-sm mt-1">The Vibe is Here ✨</p>
        </div>
        <div className="flex bg-[#0d0d18] rounded-xl p-1 mb-6">
          {["login","register"].map(m=>(
            <button key={m} onClick={()=>{setMode(m);setError("");}}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${mode===m?"bg-violet-600 text-white":"text-gray-400 hover:text-white"}`}>
              {m==="login"?"Sign In":"Create Account"}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-gray-400 font-medium mb-1.5 block">Username</label>
            <input value={username} onChange={e=>setUsername(e.target.value)} autoFocus
              className="w-full bg-[#0d0d18] border border-[#2e2e44] rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 transition-all" placeholder="Enter username" />
          </div>
          <div>
            <label className="text-xs text-gray-400 font-medium mb-1.5 block">Password</label>
            <input value={password} onChange={e=>setPassword(e.target.value)} type="password"
              className="w-full bg-[#0d0d18] border border-[#2e2e44] rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 transition-all" placeholder="Enter password" />
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <button type="submit" disabled={busy}
            className={`w-full py-3 rounded-xl transition-all text-sm font-semibold text-white ${busy?"bg-violet-800 cursor-wait":"bg-violet-600 hover:bg-violet-700"}`}>
            {busy ? (mode==="login"?"Signing in…":"Creating account…") : (mode==="login"?"Sign In →":"Create Account →")}
          </button>
          {HAS_SUPABASE && <p className="text-xs text-gray-600 text-center mt-3">☁️ Synced via Supabase — sign in from any device</p>}
          {!HAS_SUPABASE && <p className="text-xs text-gray-700 text-center mt-3">⚠ Local mode — accounts only live on this device</p>}
        </form>
      </div>
    </div>
  );
}

// ─── Share / Import modals ────────────────────────────────────────────
// ─── Settings Modal ──────────────────────────────────────────────────
function SettingsModal({ onClose, showToast }) {
  const [settings, setLocal] = React.useState(() => getSettings());
  const [uploading, setUploading] = React.useState(false);

  const update = (patch) => {
    const next = { ...settings, ...patch };
    setLocal(next);
    saveSettings(next);
    showToast("Setting saved");
  };

  // The Worker holds the service-account key + target Sheet ID — this button
  // just asks it to sync; nothing Google-related happens in the browser.
  const uploadArchive = async () => {
    setUploading(true);
    try {
      const count = await syncSongArchiveToSheet();
      showToast(`Uploaded ${count} songs`);
    } catch (e) {
      showToast(e.message || "Upload failed — try again");
      console.warn("[archive-sheet-sync]", e.message);
    } finally {
      setUploading(false);
    }
  };

  const sources = [
    { value: "tamil2lyrics-first", label: "tamil2lyrics first → fallback to lrclib",
      hint: "Best for Tamil songs (human-curated Tanglish)" },
    { value: "lrclib-first",       label: "lrclib first → fallback to tamil2lyrics",
      hint: "Faster for English / global songs" },
    { value: "tamil2lyrics-only",  label: "tamil2lyrics only",
      hint: "If lrclib's autoroman bothers you" },
    { value: "lrclib-only",        label: "lrclib only",
      hint: "Skip the proxy entirely (fastest)" },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e=>e.stopPropagation()} style={{width:"min(440px, 95vw)"}}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-white">⚙ Settings</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">✕</button>
        </div>

        <div>
          <label className="text-xs text-gray-400 font-medium block mb-2">Lyrics source preference</label>
          <div className="space-y-2">
            {sources.map(s => (
              <label key={s.value}
                className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${settings.lyricsSource === s.value ? "border-violet-500 bg-violet-600/10" : "border-[#2e2e44] hover:border-gray-500"}`}>
                <input type="radio" name="lyricsSource" value={s.value}
                  checked={settings.lyricsSource === s.value}
                  onChange={() => update({ lyricsSource: s.value })}
                  className="mt-1 accent-violet-500" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white font-medium">{s.label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{s.hint}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <p className="text-xs text-gray-600 mt-5 text-center">
          Changes take effect on the next song you open. Cached songs unaffected.
        </p>

        {HAS_SHEETS_SYNC && (
          <div className="mt-5 pt-4 border-t border-[#2a2a3e]">
            <label className="text-xs text-gray-400 font-medium block mb-2">Song archive</label>
            <button onClick={uploadArchive} disabled={uploading}
              className="w-full text-sm px-3 py-2.5 rounded-xl border border-[#2e2e44] text-gray-300 hover:border-violet-500/50 hover:text-violet-300 transition-all font-medium disabled:opacity-50 disabled:cursor-not-allowed">
              {uploading ? "Uploading…" : "⬆ Upload"}
            </button>
            <p className="text-xs text-gray-600 mt-2 text-center">
              Updates the same sheet every time — always current, no duplicates.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ShareModal({folder, user, onClose, showToast, folderSongs, onPersistRoom, onShareCodePersisted}) {
  const [shareUrl, setShareUrl] = React.useState("Generating link…");
  React.useEffect(() => {
    let alive = true;
    (async () => {
      if (folder.shareCode) {
        const base = window.location.origin + window.location.pathname;
        if (alive) setShareUrl(`${base}?share=${folder.shareCode}`);
        return;
      }
      const room = folder.broadcastRoom || newBroadcastRoom();
      if (!folder.broadcastRoom && onPersistRoom) onPersistRoom(folder.id, room);
      const { url, shareCode } = await encodeShareLink({ ...folder, broadcastRoom: room }, user, folderSongs || []);
      if (alive) {
        setShareUrl(url);
        if (shareCode && onShareCodePersisted) onShareCodePersisted(folder.id, shareCode);
      }
    })();
    return () => { alive = false; };
  }, [folder.id]);

  const copy = () => {
    navigator.clipboard.writeText(shareUrl)
      .then(() => showToast("Share link copied!"))
      .catch(() => showToast("Copy failed — select & copy manually"));
  };

  const shareNative = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `JamBook · ${folder.name}`,
          text:  `${user.username} shared a jam folder: "${folder.name}" (${folderSongs?.length || 0} songs)`,
          url:   shareUrl,
        });
      } catch {} // user cancelled — no-op
    } else {
      copy();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-bold text-white">Share Folder</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">✕</button>
        </div>
        <p className="text-sm text-gray-400 mb-1">Folder: <span className="text-violet-300 font-medium">{folder.name}</span></p>
        <p className="text-xs text-gray-600 mb-5">{folderSongs?.length || 0} songs · owned by {user.username}</p>

        <p className="text-xs text-gray-500 mb-2">Anyone with this link can import your folder</p>
        <textarea
          readOnly
          value={shareUrl}
          onFocus={e => e.target.select()}
          rows={3}
          className="w-full bg-[#0d0d18] border border-[#2e2e44] rounded-xl px-3 py-2 text-violet-300 text-xs font-mono mb-3 resize-none break-all"
        />

        <div className="flex gap-2">
          <button onClick={copy}
            className="flex-1 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-semibold transition-all">
            📋 Copy Link
          </button>
          {typeof navigator !== "undefined" && navigator.share && (
            <button onClick={shareNative}
              className="flex-1 py-2.5 border border-violet-500/40 text-violet-400 hover:bg-violet-600/10 rounded-xl text-sm font-semibold transition-all">
              ↗ Share
            </button>
          )}
        </div>

        <p className="text-xs text-gray-600 mt-4 leading-relaxed">
          Tip: Paste the link in any browser → it'll prompt to import the folder. No account required at the link source.
        </p>
      </div>
    </div>
  );
}

// Moderator-side control for the audience song-request feature. Lazily
// creates a stable request_token on first open (persisted immediately so the
// link never changes on subsequent opens), then shows it for copy/share.
function RequestLinkModal({ folder, onClose, showToast, onPersistRequestToken }) {
  const [requestUrl, setRequestUrl] = React.useState("Generating link…");

  React.useEffect(() => {
    let alive = true;
    (async () => {
      const base = window.location.origin + window.location.pathname;
      if (folder.requestToken) {
        if (alive) setRequestUrl(`${base}?request=${folder.requestToken}`);
        return;
      }
      const token = newShareToken();
      await onPersistRequestToken(folder.id, token);
      if (alive) setRequestUrl(`${base}?request=${token}`);
    })();
    return () => { alive = false; };
  }, [folder.id]);

  const copy = () => {
    navigator.clipboard.writeText(requestUrl)
      .then(() => showToast("Request link copied!"))
      .catch(() => showToast("Copy failed — select & copy manually"));
  };

  const shareNative = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `JamBook · Request a song`,
          text:  `Request a song for "${folder.name}" — no account needed!`,
          url:   requestUrl,
        });
      } catch {} // user cancelled — no-op
    } else {
      copy();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-bold text-white">🎤 Audience Request Link</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">✕</button>
        </div>
        <p className="text-sm text-gray-400 mb-1">Folder: <span className="text-violet-300 font-medium">{folder.name}</span></p>
        <p className="text-xs text-gray-600 mb-5">Anyone with this link can search and add songs straight to this folder — no account needed. The link stays the same every time.</p>

        <textarea
          readOnly
          value={requestUrl}
          onFocus={e => e.target.select()}
          rows={3}
          className="w-full bg-[#0d0d18] border border-[#2e2e44] rounded-xl px-3 py-2 text-violet-300 text-xs font-mono mb-3 resize-none break-all"
        />

        <div className="flex gap-2">
          <button onClick={copy}
            className="flex-1 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-semibold transition-all">
            📋 Copy Link
          </button>
          {typeof navigator !== "undefined" && navigator.share && (
            <button onClick={shareNative}
              className="flex-1 py-2.5 border border-violet-500/40 text-violet-400 hover:bg-violet-600/10 rounded-xl text-sm font-semibold transition-all">
              ↗ Share
            </button>
          )}
        </div>

        <p className="text-xs text-gray-600 mt-4 leading-relaxed">
          Songs requested through this link land straight in the queue — reopen the session panel to see new arrivals.
        </p>
      </div>
    </div>
  );
}

function ImportModal({user, onImport, onClose, showToast, preloadedData}) {
  const [input, setInput] = React.useState("");
  const [err,   setErr]   = React.useState("");
  const [data,  setData]  = React.useState(preloadedData || null);

  const tryParse = (value) => {
    setErr("");
    if (!value.trim()) { setData(null); return; }
    let parsed = null;
    // 1. Full URL with ?share=
    const m = value.match(/[?&]share=([^&\s]+)/);
    if (m) {
      try {
        const b64    = m[1];
        const padded = b64.replace(/-/g,"+").replace(/_/g,"/")
                          + "===".slice(0, (4 - b64.length % 4) % 4);
        parsed = JSON.parse(decodeURIComponent(escape(atob(padded))));
      } catch { setErr("Invalid share link."); return; }
    } else {
      // 2. Maybe the raw base64 payload was pasted
      try {
        const b64    = value.trim();
        const padded = b64.replace(/-/g,"+").replace(/_/g,"/")
                          + "===".slice(0, (4 - b64.length % 4) % 4);
        parsed = JSON.parse(decodeURIComponent(escape(atob(padded))));
      } catch { setErr("Paste the full share link."); return; }
    }
    if (!parsed?.folderName || !Array.isArray(parsed.songs)) { setErr("Link is missing folder data."); return; }
    setData(parsed);
  };

  const doImport = () => {
    if (!data) { setErr("Paste a share link first."); return; }
    onImport(data);
    showToast(`Imported "${data.folderName}" from ${data.ownerName}`);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-bold text-white">Import Shared Folder</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">✕</button>
        </div>

        {!preloadedData && (
          <>
            <p className="text-sm text-gray-400 mb-3">Paste the share link below.</p>
            <textarea
              value={input}
              onChange={e => { setInput(e.target.value); tryParse(e.target.value); }}
              placeholder="https://...?share=..."
              rows={3}
              className="w-full bg-[#0d0d18] border border-[#2e2e44] rounded-xl px-3 py-2 text-white text-xs font-mono mb-3 resize-none" />
          </>
        )}

        {data && (
          <div className="bg-violet-600/10 border border-violet-600/30 rounded-xl p-4 mb-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl">📁</span>
              <span className="text-base font-bold text-white">{data.folderName}</span>
            </div>
            <p className="text-xs text-gray-400">Shared by <span className="text-violet-300">{data.ownerName}</span></p>
            <p className="text-xs text-gray-500 mt-1">{data.songs?.length || 0} song{(data.songs?.length||0)!==1?"s":""}</p>
          </div>
        )}

        {err && <p className="text-red-400 text-xs mb-3">{err}</p>}
        <button onClick={doImport} disabled={!data}
          className={`w-full py-3 rounded-xl text-sm font-semibold transition-all mt-1 ${data?"bg-violet-600 hover:bg-violet-700 text-white":"bg-[#2a2a3e] text-gray-600 cursor-not-allowed"}`}>
          Import Folder
        </button>
      </div>
    </div>
  );
}

// ─── Auto Scroll ─────────────────────────────────────────────────────
function AutoScrollControl({scrollRef}) {
  const [on,setOn]       = React.useState(false);
  const [speed,setSpeed] = React.useState("medium");
  const raf   = React.useRef(null);
  const last  = React.useRef(null);
  const accum = React.useRef(0);   // sub-pixel accumulator for slow speeds

  const start = React.useCallback(spd => {
    const px = SCROLL_SPEEDS.find(s=>s.key===spd)?.px || 45;
    const el = scrollRef.current; if (!el) return;
    accum.current = 0;
    const step = ts => {
      if (!last.current) last.current = ts;
      // Accumulate sub-pixel movement so 18px/sec (0.3px/frame) still scrolls
      accum.current += px * (ts - last.current) / 1000;
      last.current = ts;
      const whole = Math.floor(accum.current);
      if (whole >= 1) {
        el.scrollTop += whole;
        accum.current -= whole;
      }
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
        setOn(false); last.current = null; accum.current = 0; return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  },[scrollRef]);

  const stop = React.useCallback(()=>{ if(raf.current) cancelAnimationFrame(raf.current); last.current=null; accum.current=0; },[]);

  React.useEffect(()=>{ if(on) start(speed); else stop(); return stop; },[on,speed]);

  return (
    <div className={`flex items-center gap-1 sm:gap-2 bg-[#1a1a2e] border rounded-xl px-2 sm:px-3 py-1.5 sm:py-2 ${on?"border-violet-500 scroll-active":"border-[#2e2e44]"}`}>
      <span className="text-xs text-gray-400 font-medium hidden sm:inline">Auto-Scroll</span>
      <div className="flex gap-0.5 sm:gap-1">
        {SCROLL_SPEEDS.map(s=>(
          <button key={s.key} onClick={()=>setSpeed(s.key)} title={s.label}
            className={`speed-btn text-xs px-1.5 sm:px-2 py-1 rounded-md sm:rounded-lg border font-medium transition-all ${speed===s.key?"active border-violet-600":"border-[#2e2e44] text-gray-400 hover:border-gray-500"}`}>
            <span className="sm:hidden">{s.label[0]}</span>
            <span className="hidden sm:inline">{s.label}</span>
          </button>
        ))}
      </div>
      <button onClick={()=>setOn(v=>!v)} title={on?"Stop":"Start"}
        className={`ml-0.5 sm:ml-1 px-2 sm:px-3 py-1 sm:py-1.5 rounded-md sm:rounded-lg text-xs font-semibold transition-all text-white ${on?"bg-red-600 hover:bg-red-700":"bg-violet-600 hover:bg-violet-700"}`}>
        {on?"⏹":"▶"}<span className="hidden sm:inline">{on?" Stop":" Start"}</span>
      </button>
    </div>
  );
}

// Lyrics/chords text-size stepper — for presenting on a big screen. Only
// scales the stanza/chord text (via the --lyrics-scale CSS var), nothing else.
function FontSizeControl({ scale, onChange }) {
  const idx = Math.max(0, FONT_SCALES.indexOf(scale));
  const step = (delta) => {
    const next = FONT_SCALES[idx + delta];
    if (next !== undefined) onChange(next);
  };
  return (
    <div className="flex items-center gap-1 sm:gap-1.5 bg-[#1a1a2e] border border-[#2e2e44] rounded-xl px-2 sm:px-3 py-1.5 sm:py-2">
      <button onClick={()=>step(-1)} disabled={idx <= 0} title="Smaller text"
        className="w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-white hover:bg-[#2a2a3e] disabled:opacity-30 disabled:cursor-not-allowed transition-all text-xs font-bold">
        A−
      </button>
      <span className="text-xs text-gray-400 font-medium w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
      <button onClick={()=>step(1)} disabled={idx >= FONT_SCALES.length - 1} title="Bigger text"
        className="w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-white hover:bg-[#2a2a3e] disabled:opacity-30 disabled:cursor-not-allowed transition-all text-sm font-bold">
        A+
      </button>
    </div>
  );
}

// ─── Queue Panel ──────────────────────────────────────────────────────
// Split a folder's songs into {pending, completed}, keeping each song's
// ORIGINAL position (i) so the number badge stays stable across both groups.
function partitionCompleted(songs) {
  const indexed = songs.map((song, i) => ({ song, i }));
  return { pending: indexed.filter(x => !x.song.completed), completed: indexed.filter(x => x.song.completed) };
}

// Queue search — matches by exact queue number OR a substring of the title/artist.
// Scoped to whatever list it's given (a single folder's songs), never global search.
function matchesQueueSearch(query, song, num) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (String(num) === q) return true;
  return (song.title || "").toLowerCase().includes(q) || (song.artist || song.singer || "").toLowerCase().includes(q);
}

function QueueSongRow({ song, i, isActive, onOpenSong, onToggleCompleted, folderId }) {
  return (
    <div onClick={() => onOpenSong(song)}
      className={`queue-song relative cursor-pointer rounded-lg border px-3 py-2.5 transition-all ${isActive ? "queue-song-active" : "border-[#1e1e2e] hover:bg-[#1a1a2e]"} ${song.completed ? "opacity-50" : ""}`}>
      {isActive && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-violet-500 rounded-r-full"/>}
      <div className="flex items-start justify-between gap-2 pl-1">
        <div className="flex items-start gap-2 min-w-0">
          <span className={`text-xs font-bold mt-0.5 w-4 flex-shrink-0 ${isActive ? "text-violet-400" : "text-gray-700"}`}>{i + 1}</span>
          <div className="min-w-0">
            <div className={`text-xs font-semibold leading-tight truncate ${song.completed ? "line-through" : ""} ${isActive ? "text-violet-200" : "text-gray-300"}`}>{song.title}</div>
            <div className="text-xs text-gray-600 truncate mt-0.5">{song.artist || song.singer}</div>
            <span className={`text-xs px-1.5 py-0.5 rounded-full mt-1 inline-block ${isActive ? "curated-badge" : "text-gray-600 bg-gray-800"}`}>
              {song.type === "curated" ? "⭐ Curated" : "🎵 Live"}
            </span>
            {song.votes > 0 && (
              <span title="Audience votes — upvoted songs move up the queue"
                className="text-xs text-pink-400 ml-1">❤️ {song.votes}</span>
            )}
          </div>
        </div>
        {onToggleCompleted && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleCompleted(folderId, song.id); }}
            title={song.completed ? "Mark as not completed" : "Mark as completed"}
            className={`w-5 h-5 mt-0.5 rounded-full border flex items-center justify-center flex-shrink-0 text-[10px] font-bold transition-all ${song.completed ? "bg-emerald-600 border-emerald-600 text-white" : "border-gray-600 text-transparent hover:border-emerald-500 hover:text-emerald-500/60"}`}>
            ✓
          </button>
        )}
      </div>
    </div>
  );
}

function FolderQueuePanel({folder,folderSongs,activeSongId,onOpenSong,onToggleCompleted,
  canBroadcast,isBroadcasting,onStartBroadcast,onStopBroadcast,viewerCount,
  broadcastModerator,collapsed,onToggleCollapse,onShuffleQueue,onRefreshQueue}) {
  const { pending, completed } = partitionCompleted(folderSongs);
  const [showSpin, setShowSpin] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [queueSearch, setQueueSearch] = React.useState("");
  const doRefresh = async () => {
    setRefreshing(true);
    try { await onRefreshQueue(folder.id); } finally { setRefreshing(false); }
  };
  // Search only ever narrows what's rendered — Spin still draws from the
  // full (unfiltered) pending list so a search doesn't shrink its pool.
  const visiblePending   = pending.filter(x => matchesQueueSearch(queueSearch, x.song, x.i + 1));
  const visibleCompleted = completed.filter(x => matchesQueueSearch(queueSearch, x.song, x.i + 1));

  if (collapsed) return (
    <div className="sidebar-transition w-12 flex-shrink-0 bg-[#0d0d18] border-l border-[#1a1a2a] flex flex-col items-center py-3 gap-3">
      <button onClick={onToggleCollapse} title="Expand session queue"
        className="text-gray-500 hover:text-violet-400 text-xl w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#1a1a2e] transition-all">‹</button>
      <div className="w-px h-4 bg-[#2a2a3a]"/>
      <div className="text-xs text-gray-600 [writing-mode:vertical-rl] rotate-180">{folder.name}</div>
    </div>
  );

  return (
    <div className="sidebar-transition w-52 flex-shrink-0 bg-[#0d0d18] border-l border-[#1a1a2a] flex flex-col h-full">
      <div className="px-4 py-4 border-b border-[#1a1a2a]">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-0.5">Session Queue</div>
          <button onClick={onToggleCollapse} title="Collapse session queue"
            className="text-gray-600 hover:text-gray-300 text-xl w-6 h-6 flex items-center justify-center rounded-lg hover:bg-[#1a1a2e] transition-all flex-shrink-0 -mt-1">›</button>
        </div>
        <div className="text-sm font-semibold text-violet-300 truncate">📁 {folder.name}</div>
        <div className="text-xs text-gray-600 mt-0.5">{folderSongs.length} songs</div>

        {/* Spin / Shuffle / Broadcast / Refresh — one strip, icon-only so all
            four fit regardless of which ones apply (e.g. no broadcast permission). */}
        <div className="mt-3 pt-3 border-t border-[#1a1a2a] flex items-center gap-1.5">
          <button
            onClick={()=>{ setShowSpin(true); if (onRefreshQueue) onRefreshQueue(folder.id); }}
            disabled={pending.length===0}
            title={pending.length===0 ? "No active songs left to spin" : "Spin to pick what's next"}
            className="flex-1 text-base py-1.5 rounded-lg border border-amber-500/40 text-amber-400 hover:bg-amber-600/10 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
            🎲
          </button>
          {onShuffleQueue && (
            <button onClick={()=>onShuffleQueue(folder.id)} disabled={pending.length<2}
              title={pending.length<2 ? "Need at least 2 active songs to shuffle" : "Shuffle song order and renumber 1..N"}
              className="flex-1 text-base py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-violet-500/50 hover:text-violet-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              🔀
            </button>
          )}
          {canBroadcast && (
            <button onClick={isBroadcasting ? onStopBroadcast : onStartBroadcast}
              title={isBroadcasting ? "Stop broadcasting" : "Start broadcasting — your song picks sync to everyone with this folder"}
              className={`flex-1 text-base py-1.5 rounded-lg border transition-all ${isBroadcasting ? "bg-red-600/20 border-red-500 text-red-300 animate-pulse" : "border-red-500/40 text-red-400 hover:bg-red-600/10"}`}>
              📡
            </button>
          )}
          {onRefreshQueue && (
            <button onClick={doRefresh} disabled={refreshing} title="Refresh — pick up songs added via a Request Songs link"
              className={`flex-1 text-base py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-violet-500/50 hover:text-violet-300 transition-all disabled:opacity-40 ${refreshing?"animate-spin":""}`}>
              🔄
            </button>
          )}
        </div>
        {canBroadcast && isBroadcasting && (
          <div className="flex items-center justify-center gap-1.5 mt-1.5 text-xs text-red-300">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"/>
            Live · <span className="text-green-400 font-medium">👥 {viewerCount}</span>
          </div>
        )}

        {/* Audience-side moderator indicator */}
        {!canBroadcast && broadcastModerator && (
          <div className="mt-3 pt-3 border-t border-[#1a1a2a]">
            <div className="flex items-center gap-1.5 text-xs text-red-300">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse"/>
              <span className="truncate">📡 {broadcastModerator.name}</span>
            </div>
          </div>
        )}
      </div>
      <div className="px-3 py-2 border-b border-[#1a1a2a]">
        <input type="text" value={queueSearch} onChange={(e)=>setQueueSearch(e.target.value)}
          placeholder="🔍 Search by name or number"
          className="w-full text-xs bg-[#1a1a2e] border border-[#2e2e44] rounded-lg px-3 py-2 text-gray-200 placeholder-gray-600 focus:border-violet-500 focus:outline-none"/>
      </div>
      <div className="flex-1 overflow-y-auto py-3 px-2 space-y-1.5">
        {visiblePending.map(({song,i})=>(
          <QueueSongRow key={song.id} song={song} i={i} isActive={song.id===activeSongId}
            onOpenSong={onOpenSong} onToggleCompleted={onToggleCompleted} folderId={folder.id}/>
        ))}
        {visibleCompleted.length > 0 && (
          <>
            <div className="text-xs text-gray-600 font-semibold uppercase tracking-wider pt-2 pb-1 px-1 border-t border-[#1a1a2a] mt-2">
              ✓ Completed ({visibleCompleted.length})
            </div>
            {visibleCompleted.map(({song,i})=>(
              <QueueSongRow key={song.id} song={song} i={i} isActive={song.id===activeSongId}
                onOpenSong={onOpenSong} onToggleCompleted={onToggleCompleted} folderId={folder.id}/>
            ))}
          </>
        )}
        {queueSearch.trim() && visiblePending.length === 0 && visibleCompleted.length === 0 && (
          <div className="text-xs text-gray-600 text-center py-6">No songs match "{queueSearch.trim()}"</div>
        )}
      </div>
      {showSpin && (
        <SpinWheelModal songs={pending.map(x=>x.song)} numbers={pending.map(x=>x.i+1)} onClose={()=>setShowSpin(false)}
          onOpenSong={(s)=>{ setShowSpin(false); onOpenSong(s); }}/>
      )}
    </div>
  );
}

// ─── Curated Song View ────────────────────────────────────────────────
function CuratedSongView({song,onBack,onAddToFolder,folders,activeFolder,folderSongs,onOpenSong,onToggleCompleted,lyricsScale,onLyricsScaleChange,queueCollapsed,onToggleQueueCollapse,onShuffleQueue,onRefreshQueue}) {
  const [showChords,setShowChords]   = React.useState(true);
  const [script,setScript]           = React.useState("roman");
  const [showFolderMenu,setFolderMenu] = React.useState(false);
  const scrollRef = React.useRef(null);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [song.id]);

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
        <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-[#1e1e2e] flex-shrink-0">
          <div className="min-w-0 flex-1 mr-4">
            <button onClick={onBack} className="text-violet-400 hover:text-violet-300 text-xs mb-1.5">← Back to Search</button>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-white">{script==="native"?song.titleNative:song.title}</h1>
              <span className="text-xs px-2 py-0.5 rounded-full font-semibold curated-badge">⭐ Curated</span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-gray-400">
              <span>🎬 {song.movie}</span><span>🎤 {song.singer}</span><span>🎵 {song.composer}</span><span>📅 {song.year}</span>
              <span className={`px-1.5 py-0.5 rounded-full font-medium ${LANG_COLORS[song.language]||"bg-gray-700 text-gray-300"}`}>{song.language}</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <div className="script-toggle">
              <div onClick={()=>setScript("roman")} className={`script-opt ${script==="roman"?"active":""}`}>Romanized</div>
              <div onClick={()=>setScript("native")} className={`script-opt ${script==="native"?"active":""}`}>Native</div>
            </div>
            <div className="flex gap-2 flex-wrap justify-end">
              <button onClick={()=>setShowChords(v=>!v)}
                className={`text-xs px-2.5 py-1.5 rounded-lg border font-medium transition-all ${showChords?"bg-amber-600/20 border-amber-500/40 text-amber-400":"border-[#2e2e44] text-gray-400 hover:border-gray-500"}`}>
                {showChords?"🎸 Chords ON":"🎸 Chords OFF"}
              </button>
              <a href={torrinsLink(song.title)} target="_blank" rel="noopener"
                className="text-xs px-2.5 py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-green-500 hover:text-green-400 transition-all">Torrins ↗</a>
              <div className="relative">
                <button onClick={()=>setFolderMenu(v=>!v)} className="text-xs px-2.5 py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-violet-500 hover:text-violet-400 transition-all">📁 Add</button>
                {showFolderMenu&&(
                  <div className="absolute right-0 top-full mt-1 bg-[#1a1a2e] border border-[#2e2e44] rounded-xl shadow-xl z-50 min-w-44">
                    {folders.length===0&&<div className="px-4 py-3 text-xs text-gray-500">No folders yet.</div>}
                    {folders.map(f=>(
                      <button key={f.id} onClick={()=>{onAddToFolder(f.id,song);setFolderMenu(false);}}
                        className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-violet-600/20 hover:text-violet-300 first:rounded-t-xl last:rounded-b-xl transition-all">
                        📁 {f.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="px-5 py-2 border-b border-[#1a1a2a] flex flex-wrap gap-2 items-center flex-shrink-0">
          <span className="text-xs text-gray-600">Vocal:</span>
          {Object.entries(TAG_CONFIG).map(([k,v])=>(
            <span key={k} className={`text-xs px-2 py-0.5 rounded-full ${v.class}`}>{v.label}</span>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <FontSizeControl scale={lyricsScale} onChange={onLyricsScaleChange}/>
            <AutoScrollControl scrollRef={scrollRef}/>
          </div>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-1" style={{"--lyrics-scale":lyricsScale}}>
          {song.lines.map(line=>(
            <div key={line.id} className="lyric-line px-3 py-2 transition-all">
              {showChords&&<div className="mb-0.5"><ChordBadge chord={line.chord}/></div>}
              <div className="flex items-center gap-3">
                <Tag type={line.tag}/>
                <span className={`leading-relaxed font-medium text-gray-100 ${script==="native"?"tamil-text":""}`}
                  style={{fontSize:"calc(1rem * var(--lyrics-scale, 1))"}}>
                  {script==="native"?line.textNative:line.textRoman}
                </span>
              </div>
            </div>
          ))}
          <div className="h-16"/>
        </div>
      </div>
      {activeFolder&&folderSongs&&folderSongs.length>0&&(
        <FolderQueuePanel folder={activeFolder} folderSongs={folderSongs} activeSongId={song.id} onOpenSong={onOpenSong} onToggleCompleted={onToggleCompleted} collapsed={queueCollapsed} onToggleCollapse={onToggleQueueCollapse} onShuffleQueue={onShuffleQueue} onRefreshQueue={onRefreshQueue}/>
      )}
    </div>
  );
}

// ─── Chord button — opens Ultimate Guitar search in a new tab ────────
// No more pre-check via CORS proxies (they're unreliable on many networks).
// User clicks → site opens in a new tab → they pick the chord sheet they want.
function ChordButton({ song }) {
  const artist = song.artist || song.singer || "";
  return (
    <a href={ugLink(song.title, artist)} target="_blank" rel="noopener"
      title="Search chords on Ultimate Guitar"
      className="text-xs px-2 py-1.5 rounded-lg bg-amber-600/20 border border-amber-500/50 text-amber-300 hover:bg-amber-600/30 transition-all font-medium whitespace-nowrap">
      🎸<span className="hidden sm:inline"> Chords ↗</span>
    </a>
  );
}

// ─── Live Song View (iTunes) ──────────────────────────────────────────
function LiveSongView({song,onBack,onAddToFolder,folders,activeFolder,folderSongs,onOpenSong,onEditSong,onShareFolder,onToggleCompleted,
  isBroadcasting, broadcastModerator, followingBroadcast, onLeaveBroadcast,
  canBroadcast, onStartBroadcast, onStopBroadcast, viewerCount,
  onBroadcastSourceChange, lyricsRefreshTick, lyricsScale, onLyricsScaleChange,
  queueCollapsed, onToggleQueueCollapse, onShuffleQueue, onRefreshQueue}) {
  const [lyricsData, setLyricsData] = React.useState(null); // {lyrics, source}
  const [loading,    setLoading]    = React.useState(true);
  const [notFound,   setNotFound]   = React.useState(false);
  const [switching,  setSwitching]  = React.useState(false);
  const [showFolderMenu, setFolderMenu] = React.useState(false);
  const [showActionMenu, setShowActionMenu] = React.useState(false);
  const [script,     setScript]     = React.useState("roman"); // "roman" | "native"
  const [wasCached,  setWasCached]  = React.useState(false);
  const [googleRoman,setGoogleRoman]= React.useState(null);
  const [preferLocal, setPreferLocal] = React.useState(false);
  const [romanizing, setRomanizing] = React.useState(false);
  const scrollRef = React.useRef(null);

  const hasCustomLyrics = !!(song.customLyrics || song.customLyricsRoman);
  const isCustomSong    = song.type === "custom";

  // Re-read cache + reset state whenever song.id changes.
  // If the song carries its own customLyrics (user-added or user-edited),
  // skip API fetch entirely.
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setGoogleRoman(null); setRomanizing(false);
    if (hasCustomLyrics) {
      // Use native if provided, else fall back to the roman version as the "source" text.
      const baseText = song.customLyrics || song.customLyricsRoman || "";
      setLyricsData({ lyrics: baseText, source: isCustomSong ? "your lyrics" : "your edit" });
      setLoading(false); setNotFound(false); setWasCached(true);
      return;
    }
    const cached = getCachedLyrics(song.id);
    if (cached) {
      setLyricsData(cached); setLoading(false); setNotFound(false); setWasCached(true);
      if (cached.googleRoman) setGoogleRoman(cached.googleRoman);
      return;
    }
    setLyricsData(null); setLoading(true); setNotFound(false); setWasCached(false);
    fetchLyricsRace(song.artist, song.title, song.album).then(result => {
      if (result) { setLyricsData(result); setCachedLyrics(song.id, result); }
      else        { setNotFound(true); }
      setLoading(false);
    });
  }, [song.id, song.customLyrics, song.customLyricsRoman, lyricsRefreshTick]);

  // Switch source manually. If I'm the moderator, push the new lyrics to followers.
  const switchSource = async (src) => {
    setSwitching(true); setGoogleRoman(null);
    const result = await fetchLyricsFromSource(song.artist, song.title, src, song.album);
    if (result) {
      setLyricsData(result);
      setCachedLyrics(song.id, result);
      setNotFound(false);
      if (isBroadcasting && onBroadcastSourceChange) {
        onBroadcastSourceChange(song.id, result);
      }
    } else {
      setNotFound(true); setLyricsData(null);
    }
    setSwitching(false);
  };

  const otherSources = LYRIC_SOURCES.filter(s => s !== lyricsData?.source);

  const preRomanized = !!lyricsData?.alreadyRomanized;
  // If the source supplied a separate native-script version (e.g. tamil2lyrics
  // sends both Tanglish AND Tamil), enable the toggle even when preRomanized.
  const hasNativeAttached = !!lyricsData?.nativeLyrics;
  const nativeScript = (!preRomanized && lyricsData?.lyrics) ? detectScript(lyricsData.lyrics)
                     : (hasNativeAttached ? detectScript(lyricsData.nativeLyrics) : null);

  // Kick off Google romanization once lyrics arrive (if needed and not cached).
  React.useEffect(() => {
    if (!lyricsData?.lyrics || preRomanized || !nativeScript) return;
    if (googleRoman) return;
    setRomanizing(true);
    googleRomanize(lyricsData.lyrics).then(roman => {
      setRomanizing(false);
      if (roman) {
        setGoogleRoman(roman);
        setCachedLyrics(song.id, { ...lyricsData, googleRoman: roman });
      }
    });
  }, [lyricsData, nativeScript, preRomanized]);

  const displayText = React.useMemo(() => {
    if (!lyricsData?.lyrics) return null;

    if (script === "native") {
      // Native mode — use source-supplied native text if available, else the API blob
      if (lyricsData.nativeLyrics) return lyricsData.nativeLyrics;
      return lyricsData.lyrics;
    }

    // script === "roman"
    if (preRomanized) return lyricsData.lyrics; // source already gave us Tanglish
    if (song.customLyricsRoman) return song.customLyricsRoman;
    if (!nativeScript)        return lyricsData.lyrics;
    if (preferLocal || !googleRoman) return transliterateLocal(lyricsData.lyrics);
    return googleRoman;
  }, [lyricsData, script, nativeScript, preRomanized, googleRoman, preferLocal, song.customLyricsRoman]);

  const stanzas = displayText
    ? parseStructured(displayText, { skipAutoNumber: !!lyricsData?.structured })
    : [];

  const isMobile = useIsMobile();
  const [showQueue, setShowQueue] = React.useState(false);
  const [showSpin, setShowSpin] = React.useState(false);
  const [queueSearch, setQueueSearch] = React.useState("");
  const [showSourceMenu, setShowSourceMenu] = React.useState(false);
  const hasQueue = activeFolder && folderSongs && folderSongs.length > 0;
  const pendingQueueSongs = hasQueue ? partitionCompleted(folderSongs).pending : [];

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">

        {/* Header — two compact rows on mobile, single row on desktop */}
        <div className="px-3 sm:px-5 pt-2.5 sm:pt-4 pb-2 sm:pb-3 border-b border-[#1e1e2e] flex-shrink-0">
          {/* Row 1: back + title (full width on mobile) */}
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={onBack} title="Back"
              className="text-violet-400 hover:text-violet-300 text-lg flex-shrink-0 px-1">←</button>
            <div className="flex-1 min-w-0">
              <h1 className="text-sm sm:text-xl font-bold text-white truncate leading-tight flex items-center gap-1.5">
                <span className="truncate">{song.title}</span>
                {(isBroadcasting || (broadcastModerator && followingBroadcast)) && (
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
                )}
              </h1>
              <div className="text-xs text-gray-500 truncate">
                🎤 {song.artist}
                {broadcastModerator && followingBroadcast && (
                  <span className="ml-2 text-red-400">· Following {broadcastModerator.name}</span>
                )}
                {isBroadcasting && <span className="ml-2 text-red-400">· 🔴 Live</span>}
              </div>
            </div>
            {/* Top-bar action buttons — desktop + mobile share the same layout now */}
            <div className="flex gap-1.5 flex-shrink-0" onClick={e=>e.stopPropagation()}>
              {/* Add to folder */}
              <div className="relative">
                <button onClick={()=>{setFolderMenu(v=>!v); setShowActionMenu(false);}}
                  title="Add to folder"
                  className="text-xs px-2 py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-violet-500 hover:text-violet-400 transition-all">📁<span className="hidden sm:inline ml-1">Add</span></button>
                {showFolderMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-[#1a1a2e] border border-[#2e2e44] rounded-xl shadow-xl z-50 min-w-44">
                    {folders.length===0 && <div className="px-4 py-3 text-xs text-gray-500">No folders yet.</div>}
                    {folders.map(f=>(
                      <button key={f.id} onClick={()=>{onAddToFolder(f.id,song);setFolderMenu(false);}}
                        className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-violet-600/20 hover:text-violet-300 first:rounded-t-xl last:rounded-b-xl transition-all">
                        📁 {f.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Mark this song completed (only when viewing a song inside a folder) */}
              {activeFolder && onToggleCompleted && (
                <button onClick={()=>onToggleCompleted(activeFolder.id, song.id)}
                  title={song.completed ? "Mark as not completed" : "Mark as completed"}
                  className={`text-xs px-2 py-1.5 rounded-lg border transition-all ${song.completed ? "bg-emerald-600/20 border-emerald-600/40 text-emerald-400" : "border-[#2e2e44] text-gray-400 hover:border-emerald-500 hover:text-emerald-400"}`}>
                  {song.completed ? "✓" : "○"}<span className="hidden sm:inline ml-1">{song.completed ? "Completed" : "Complete"}</span>
                </button>
              )}

              {/* Share folder (only when viewing a song inside a folder) */}
              {activeFolder && onShareFolder && (
                <button onClick={()=>onShareFolder(activeFolder)}
                  title="Share this folder"
                  className="text-xs px-2 py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-violet-500 hover:text-violet-400 transition-all">↗<span className="hidden sm:inline ml-1">Share</span></button>
              )}

              {/* Session queue (mobile only) */}
              {isMobile && hasQueue && (
                <button onClick={()=>setShowQueue(true)} title="Session queue"
                  className="text-xs px-2 py-1.5 rounded-lg border border-violet-500/40 text-violet-400 hover:bg-violet-600/10 transition-all">
                  ☰ {folderSongs.length}
                </button>
              )}

              {/* Hamburger menu — Source · Edit · Chords */}
              <div className="relative">
                <button onClick={()=>{setShowActionMenu(v=>!v); setFolderMenu(false);}}
                  title="More actions"
                  className="text-xs px-2 py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-violet-500 hover:text-violet-400 transition-all">⋮</button>
                {showActionMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-[#1a1a2e] border border-[#2e2e44] rounded-xl shadow-xl z-50 min-w-56 overflow-hidden">
                    {/* Source switcher — hidden for followers of an active broadcast */}
                    {lyricsData?.source && !(broadcastModerator && !isBroadcasting) && (
                      <div className="px-4 py-2 border-b border-[#2e2e44]">
                        <div className="text-xs text-gray-500 mb-1.5">Source</div>
                        <div className="text-xs text-violet-300 font-medium mb-2">✓ {lyricsData.source}</div>
                        {!switching && otherSources.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {otherSources.map(src => (
                              <button key={src} onClick={()=>{switchSource(src);setShowActionMenu(false);}}
                                className="text-xs px-2 py-1 rounded-md border border-[#2e2e44] text-gray-400 hover:text-violet-300 hover:border-violet-500 transition-all">
                                Try {src}
                              </button>
                            ))}
                          </div>
                        )}
                        {switching && <div className="text-xs text-gray-500 flex items-center gap-1"><div className="w-3 h-3 border border-violet-500 border-t-transparent rounded-full animate-spin"/>Switching…</div>}
                      </div>
                    )}

                    {/* Edit Lyrics — hidden for followers of an active broadcast */}
                    {onEditSong && !(broadcastModerator && !isBroadcasting) && (
                      <button onClick={()=>{onEditSong(song, displayText || lyricsData?.lyrics || ""); setShowActionMenu(false);}}
                        className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-amber-600/15 hover:text-amber-300 transition-all border-b border-[#2e2e44]">
                        ✎ Edit Lyrics
                      </button>
                    )}

                    {/* Follower notice */}
                    {broadcastModerator && !isBroadcasting && (
                      <div className="px-4 py-2 text-xs text-gray-500 border-b border-[#2e2e44]">
                        🔒 Editing locked while {broadcastModerator.name} is broadcasting
                      </div>
                    )}

                    {/* Find Chords */}
                    {!isCustomSong && (
                      <a href={ugLink(song.title, song.artist || song.singer || "")}
                        target="_blank" rel="noopener"
                        onClick={()=>setShowActionMenu(false)}
                        className="block px-4 py-2.5 text-sm text-gray-300 hover:bg-amber-600/15 hover:text-amber-300 transition-all">
                        🎸 Find Chords ↗
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Source bar — minimal: script toggle + autoscroll only */}
        <div className="px-3 sm:px-5 py-1.5 sm:py-2 border-b border-[#1a1a2a] flex items-center gap-2 flex-shrink-0">
          {nativeScript && (
            <div className="script-toggle">
              <div onClick={()=>setScript("roman")} className={`script-opt ${script==="roman"?"active":""}`}>{isMobile?"Aa":"Romanized"}</div>
              <div onClick={()=>setScript("native")} className={`script-opt ${script==="native"?"active":""}`}>{isMobile?"அ":"Native"}</div>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <FontSizeControl scale={lyricsScale} onChange={onLyricsScaleChange}/>
            <AutoScrollControl scrollRef={scrollRef}/>
          </div>
        </div>

        {/* Lyrics body */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-5">
          {loading && (
            <div className="space-y-3">
              <Spinner/>
              <p className="text-center text-xs text-gray-600">Racing lrclib{HAS_PROXY?" + tamil2lyrics":""} — fastest wins</p>
            </div>
          )}
          {!loading && notFound && (
            <div className="text-center py-16">
              <div className="text-5xl mb-4">🎵</div>
              <p className="text-gray-300 font-semibold text-base mb-1">Couldn't find lyrics for this song</p>
              <p className="text-gray-600 text-sm mb-6">All sources tried — open DevTools console for details. You can also add the lyrics manually below.</p>
              <button
                onClick={() => {
                  setNotFound(false); setLoading(true);
                  fetchLyricsRace(song.artist, song.title, song.album).then(result => {
                    if (result) { setLyricsData(result); setCachedLyrics(song.id, result); }
                    else setNotFound(true);
                    setLoading(false);
                  });
                }}
                className="px-6 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-semibold transition-all">
                ↺ Try Again
              </button>
            </div>
          )}
          {!loading && lyricsData?.lyrics && (
            <div className="max-w-3xl mx-auto" style={{"--lyrics-scale":lyricsScale}}>
              {stanzas.map((stanza, i) => (
                <div key={i} className="stanza">
                  {stanza.section && (
                    <div className={`stanza-section ${TAG_BG[stanza.section.tag] || TAG_BG.verse}`}>
                      {stanza.section.label}
                    </div>
                  )}
                  {stanza.lines.map((line, j) => {
                    if (line.kind === "blank") return <div key={j} className="h-2" />;
                    if (line.kind === "chord") return <div key={j} className="chord-line">{line.text}</div>;
                    return <div key={j} className="stanza-line">{line.text}</div>;
                  })}
                </div>
              ))}
              <div className="mt-8 pt-4 border-t border-[#1a1a2a] text-xs text-gray-600 text-center">
                Tip: Use the 🎸 button above for chord sheets.
              </div>
            </div>
          )}
          <div className="h-16"/>
        </div>
      </div>

      {/* Desktop inline queue panel */}
      {hasQueue && !isMobile && (
        <FolderQueuePanel folder={activeFolder} folderSongs={folderSongs} activeSongId={song.id} onOpenSong={onOpenSong} onToggleCompleted={onToggleCompleted}
          canBroadcast={canBroadcast}
          isBroadcasting={isBroadcasting}
          onStartBroadcast={onStartBroadcast}
          onStopBroadcast={onStopBroadcast}
          viewerCount={viewerCount}
          broadcastModerator={broadcastModerator}
          collapsed={queueCollapsed}
          onToggleCollapse={onToggleQueueCollapse}
          onShuffleQueue={onShuffleQueue}
          onRefreshQueue={onRefreshQueue}
        />
      )}

      {/* Mobile slide-in queue drawer */}
      {hasQueue && isMobile && showQueue && (
        <>
          <div className="drawer-backdrop" onClick={()=>setShowQueue(false)} />
          <div className="drawer-panel flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a2a] flex-shrink-0">
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Session Queue</div>
                <div className="text-sm font-semibold text-violet-300 truncate">📁 {activeFolder.name}</div>
              </div>
              <button onClick={()=>setShowQueue(false)} className="text-gray-500 hover:text-white text-xl">✕</button>
            </div>
            <div className="px-4 py-2.5 border-b border-[#1a1a2a]">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={()=>{ setShowSpin(true); if (onRefreshQueue) onRefreshQueue(activeFolder.id); }}
                  disabled={pendingQueueSongs.length===0}
                  title={pendingQueueSongs.length===0 ? "No active songs left to spin" : "Spin to pick what's next"}
                  className="flex-1 text-base py-1.5 rounded-lg border border-amber-500/40 text-amber-400 hover:bg-amber-600/10 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                  🎲
                </button>
                {onShuffleQueue && (
                  <button onClick={()=>onShuffleQueue(activeFolder.id)} disabled={pendingQueueSongs.length<2}
                    title={pendingQueueSongs.length<2 ? "Need at least 2 active songs to shuffle" : "Shuffle song order and renumber 1..N"}
                    className="flex-1 text-base py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-violet-500/50 hover:text-violet-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                    🔀
                  </button>
                )}
                {canBroadcast && (
                  <button onClick={isBroadcasting ? onStopBroadcast : ()=>{onStartBroadcast(); setShowQueue(false);}}
                    title={isBroadcasting ? "Stop broadcasting" : "Start broadcasting"}
                    className={`flex-1 text-base py-1.5 rounded-lg border transition-all ${isBroadcasting ? "bg-red-600/20 border-red-500 text-red-300 animate-pulse" : "border-red-500/40 text-red-400 hover:bg-red-600/10"}`}>
                    📡
                  </button>
                )}
                {onRefreshQueue && (
                  <button onClick={()=>onRefreshQueue(activeFolder.id)}
                    title="Refresh — pick up songs added via a Request Songs link"
                    className="flex-1 text-base py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-violet-500/50 hover:text-violet-300 transition-all">
                    🔄
                  </button>
                )}
              </div>
              {canBroadcast && isBroadcasting && (
                <div className="flex items-center justify-center gap-1.5 mt-1.5 text-xs text-red-300">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"/>
                  Live · <span className="text-green-400 font-medium">👥 {viewerCount}</span>
                </div>
              )}
              {!canBroadcast && broadcastModerator && (
                <div className="flex items-center gap-1.5 text-xs text-red-300 mt-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse"/>
                  <span className="truncate">📡 {broadcastModerator.name} is live</span>
                </div>
              )}
            </div>
            <div className="px-4 py-2.5 border-b border-[#1a1a2a]">
              <input type="text" value={queueSearch} onChange={(e)=>setQueueSearch(e.target.value)}
                placeholder="🔍 Search by name or number"
                className="w-full text-xs bg-[#1a1a2e] border border-[#2e2e44] rounded-lg px-3 py-2 text-gray-200 placeholder-gray-600 focus:border-violet-500 focus:outline-none"/>
            </div>
            <div className="flex-1 overflow-y-auto py-3 px-2 space-y-1.5">
              {(() => {
                const { pending: allPending, completed: allCompleted } = partitionCompleted(folderSongs);
                const pending   = allPending.filter(x => matchesQueueSearch(queueSearch, x.song, x.i + 1));
                const completed = allCompleted.filter(x => matchesQueueSearch(queueSearch, x.song, x.i + 1));
                const row = ({song: s, i}) => (
                  <div key={s.id} onClick={()=>{onOpenSong(s); setShowQueue(false);}}
                    className={`queue-song relative cursor-pointer rounded-lg border px-3 py-2.5 transition-all ${s.id===song.id?"queue-song-active":"border-[#1e1e2e]"} ${s.completed?"opacity-50":""}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0">
                        <span className={`text-xs font-bold mt-0.5 w-4 flex-shrink-0 ${s.id===song.id?"text-violet-400":"text-gray-700"}`}>{i+1}</span>
                        <div className="min-w-0 flex-1">
                          <div className={`text-sm font-semibold leading-tight truncate ${s.completed?"line-through":""} ${s.id===song.id?"text-violet-200":"text-gray-300"}`}>{s.title}</div>
                          <div className="text-xs text-gray-600 truncate mt-0.5">
                            {s.artist || s.singer}
                            {s.votes > 0 && <span className="text-pink-400 ml-1.5">❤️ {s.votes}</span>}
                          </div>
                        </div>
                      </div>
                      {onToggleCompleted && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onToggleCompleted(activeFolder.id, s.id); }}
                          title={s.completed ? "Mark as not completed" : "Mark as completed"}
                          className={`w-5 h-5 mt-0.5 rounded-full border flex items-center justify-center flex-shrink-0 text-[10px] font-bold transition-all ${s.completed ? "bg-emerald-600 border-emerald-600 text-white" : "border-gray-600 text-transparent hover:border-emerald-500 hover:text-emerald-500/60"}`}>
                          ✓
                        </button>
                      )}
                    </div>
                  </div>
                );
                return (
                  <>
                    {pending.map(row)}
                    {completed.length > 0 && (
                      <>
                        <div className="text-xs text-gray-600 font-semibold uppercase tracking-wider pt-2 pb-1 px-1 border-t border-[#1a1a2a] mt-2">
                          ✓ Completed ({completed.length})
                        </div>
                        {completed.map(row)}
                      </>
                    )}
                    {queueSearch.trim() && pending.length === 0 && completed.length === 0 && (
                      <div className="text-xs text-gray-600 text-center py-6">No songs match "{queueSearch.trim()}"</div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </>
      )}

      {showSpin && (
        <SpinWheelModal songs={pendingQueueSongs.map(x=>x.song)} numbers={pendingQueueSongs.map(x=>x.i+1)}
          onClose={()=>setShowSpin(false)}
          onOpenSong={(s)=>{ setShowSpin(false); onOpenSong(s); }}/>
      )}
    </div>
  );
}

// ─── Folder View ──────────────────────────────────────────────────────
// ─── Lyrics Editor Modal ─────────────────────────────────────────────
// Lets users edit BOTH the native-script version and the Tanglish version
// independently. Tab switcher above the textarea controls which one is shown.
function LyricsEditorModal({ initialSong, mode, onSave, onClose, folders, needsFolderPick }) {
  const isEdit = mode === "edit";
  const [title,    setTitle]    = React.useState(initialSong?.title    || "");
  const [artist,   setArtist]   = React.useState(initialSong?.artist   || "");
  const [album,    setAlbum]    = React.useState(initialSong?.album    || "");
  const [language, setLanguage] = React.useState(initialSong?.language || "Tamil");
  const [nativeLyrics,   setNativeLyrics]   = React.useState(initialSong?.customLyrics || "");
  const [romanLyrics,    setRomanLyrics]    = React.useState(initialSong?.customLyricsRoman || "");
  const [scriptTab, setScriptTab] = React.useState(
    initialSong?.customLyrics ? "native" : (initialSong?.customLyricsRoman ? "roman" : "native")
  );
  const [pickedFolderId, setPickedFolderId] = React.useState(
    needsFolderPick && folders && folders.length > 0 ? folders[0].id : null
  );
  const [err, setErr] = React.useState("");
  const lyricsRef = React.useRef(null);

  const currentLyrics    = scriptTab === "native" ? nativeLyrics    : romanLyrics;
  const setCurrentLyrics = scriptTab === "native" ? setNativeLyrics : setRomanLyrics;

  // Generate romanized text from native via Google (any Indic script) →
  // falls back to local rule-based mapper if Google is unreachable.
  const [autoFillBusy, setAutoFillBusy] = React.useState(false);
  const autoFillTanglish = async () => {
    if (!nativeLyrics.trim() || autoFillBusy) return;
    setAutoFillBusy(true);
    try {
      const result = await transliterateBest(nativeLyrics);
      setRomanLyrics(result.text);
      setScriptTab("roman");
    } finally {
      setAutoFillBusy(false);
    }
  };

  const insertAtCursor = (snippet) => {
    const el = lyricsRef.current; if (!el) return;
    const start = el.selectionStart, end = el.selectionEnd;
    const before = currentLyrics.slice(0, start), after = currentLyrics.slice(end);
    const sep = (before && !before.endsWith("\n")) ? "\n" : "";
    const next = before + sep + snippet + "\n" + after;
    setCurrentLyrics(next);
    setTimeout(() => {
      const pos = (before + sep + snippet + "\n").length;
      el.focus(); el.setSelectionRange(pos, pos);
    }, 0);
  };

  const save = () => {
    setErr("");
    if (!title.trim())                                 { setErr("Title is required."); return; }
    if (!nativeLyrics.trim() && !romanLyrics.trim())   { setErr("Add lyrics in at least one script."); return; }
    if (needsFolderPick && !pickedFolderId)            { setErr("Pick a folder to save into."); return; }
    onSave({
      title:              title.trim(),
      artist:             artist.trim() || "Unknown",
      album:              album.trim()  || "",
      language:           language,
      customLyrics:       nativeLyrics,
      customLyricsRoman:  romanLyrics,
      folderId:           pickedFolderId,
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e=>e.stopPropagation()} style={{width:"min(560px, 95vw)"}}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-white">{isEdit ? "Edit Lyrics" : "Add Your Own Song"}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">✕</button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 font-medium mb-1 block">Title <span className="text-red-400">*</span></label>
            <input value={title} onChange={e=>setTitle(e.target.value)} autoFocus={!isEdit}
              className="w-full bg-[#0d0d18] border border-[#2e2e44] rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600"
              placeholder="Song title" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-400 font-medium mb-1 block">Singer</label>
              <input value={artist} onChange={e=>setArtist(e.target.value)}
                className="w-full bg-[#0d0d18] border border-[#2e2e44] rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600"
                placeholder="Optional" />
            </div>
            <div>
              <label className="text-xs text-gray-400 font-medium mb-1 block">Movie / Album</label>
              <input value={album} onChange={e=>setAlbum(e.target.value)}
                className="w-full bg-[#0d0d18] border border-[#2e2e44] rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600"
                placeholder="Optional" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-400 font-medium mb-1 block">Language</label>
              <select value={language} onChange={e=>setLanguage(e.target.value)}
                className="w-full bg-[#0d0d18] border border-[#2e2e44] rounded-lg px-3 py-2 text-white text-sm">
                {LANGUAGES.filter(l => l !== "All").map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            {needsFolderPick && (
              <div>
                <label className="text-xs text-gray-400 font-medium mb-1 block">Save to folder <span className="text-red-400">*</span></label>
                <select value={pickedFolderId || ""} onChange={e=>setPickedFolderId(e.target.value)}
                  className="w-full bg-[#0d0d18] border border-[#2e2e44] rounded-lg px-3 py-2 text-white text-sm">
                  {(folders || []).map(f => <option key={f.id} value={f.id}>📁 {f.name}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* Vocal/chord toolbar */}
          <div className="flex flex-wrap gap-1 pt-1">
            <span className="text-xs text-gray-600 self-center mr-1">Insert:</span>
            {["[Verse]","[Chorus]","[Male]","[Female]","[Duet]","[Humming]","[Bridge]"].map(m => (
              <button key={m} type="button" onClick={()=>insertAtCursor(m)}
                className="text-xs px-2 py-0.5 rounded-md border border-[#2a2a3e] text-gray-400 hover:border-violet-500 hover:text-violet-400">
                {m}
              </button>
            ))}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
              <label className="text-xs text-gray-400 font-medium">
                Lyrics <span className="text-red-400">*</span>
                <span className="text-gray-600 ml-1">({scriptTab === "native" ? "native script" : "Tanglish / Roman"})</span>
              </label>
              <div className="flex items-center gap-2">
                {scriptTab === "roman" && nativeLyrics.trim() && (
                  <button type="button" onClick={autoFillTanglish} disabled={autoFillBusy}
                    title="Auto-fill from native lyrics (Google romanization for any Indic script)"
                    className="text-xs text-violet-400 hover:text-violet-300 underline-offset-2 hover:underline disabled:opacity-50 disabled:cursor-wait">
                    {autoFillBusy ? "Translating…" : "↻ Auto-fill"}
                  </button>
                )}
                <div className="script-toggle">
                  <div onClick={()=>setScriptTab("native")}
                    className={`script-opt ${scriptTab==="native"?"active":""}`}>
                    Native {nativeLyrics.trim() && <span className="text-green-400 ml-0.5">●</span>}
                  </div>
                  <div onClick={()=>setScriptTab("roman")}
                    className={`script-opt ${scriptTab==="roman"?"active":""}`}>
                    Tanglish {romanLyrics.trim() && <span className="text-green-400 ml-0.5">●</span>}
                  </div>
                </div>
              </div>
            </div>
            <textarea ref={lyricsRef} value={currentLyrics} onChange={e=>setCurrentLyrics(e.target.value)}
              rows={12}
              className="w-full bg-[#0d0d18] border border-[#2e2e44] rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 font-mono leading-relaxed resize-y"
              placeholder={scriptTab === "native"
                ? `Paste native-script lyrics here...\n\nTip:\n[Chorus]   ← marks a section\n[Male]     ← Male singer\nC  G  Am   ← chord line`
                : `Paste Tanglish / Roman lyrics here...\n\nUse the ↻ Auto-fill button to convert from native automatically.`} />
            <p className="text-xs text-gray-600 mt-1">
              You can fill either or both. Markers like <code className="text-violet-400">[Chorus]</code> add vocal tags. Lines with only chord letters (<code className="text-violet-400">C G Am F</code>) render as chord rows.
            </p>
          </div>

          {err && <p className="text-red-400 text-xs">{err}</p>}

          <button onClick={save}
            className="w-full py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-semibold transition-all">
            {isEdit ? "Save Edits" : "Add Song"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Spin Wheel Modal ─────────────────────────────────────────────────
// Pick 3–5 songs, spin a wheel, let it land on one and open its lyrics.
function SpinWheelModal({ songs: rawSongs, numbers: rawNumbers, onOpenSong, onClose }) {
  // Defensive dedupe by id — the same real song can otherwise take up
  // multiple wheel segments (e.g. requested more than once under a
  // different source id), which makes the wheel land on "the same song"
  // far more often than it looks like it should.
  const { songs, numbers } = React.useMemo(() => {
    const seen = new Set(), s = [], n = [];
    rawSongs.forEach((song, i) => {
      if (seen.has(song.id)) return;
      seen.add(song.id);
      s.push(song);
      n.push(rawNumbers ? rawNumbers[i] : i + 1);
    });
    return { songs: s, numbers: n };
  }, [rawSongs, rawNumbers]);

  const [numberInputs, setNumberInputs] = React.useState(["", "", "", "", ""]);
  const [showNames, setShowNames]     = React.useState(false); // hidden by default — keep the pick a surprise while spinning
  const [rotation, setRotation]       = React.useState(0);
  const [spinning, setSpinning]       = React.useState(false);
  const [winner, setWinner]           = React.useState(null);
  const pendingWinnerRef = React.useRef(null);

  // Map each song's displayed queue number back to the song itself, so typed
  // numbers resolve to the right song regardless of completed songs being
  // filtered out of `songs` (numbers stay tied to original queue position).
  const numberToSong = React.useMemo(() => {
    const map = {};
    songs.forEach((s, i) => { map[numbers ? numbers[i] : i + 1] = s; });
    return map;
  }, [songs, numbers]);
  // ...and the reverse — a song's id back to its queue number, for display
  // when names are hidden.
  const songToNumber = React.useMemo(() => {
    const map = {};
    songs.forEach((s, i) => { map[s.id] = numbers ? numbers[i] : i + 1; });
    return map;
  }, [songs, numbers]);
  const maxNumber = numbers && numbers.length ? Math.max(...numbers) : songs.length;

  const enteredRaw = numberInputs.map(v => v.trim()).filter(Boolean);
  const matchedSongs = [];
  { const seen = new Set();
    for (const raw of enteredRaw) {
      const s = numberToSong[parseInt(raw, 10)];
      if (s && !seen.has(s.id)) { matchedSongs.push(s); seen.add(s.id); }
    }
  }
  const invalidCount = enteredRaw.filter(raw => !numberToSong[parseInt(raw, 10)]).length;

  // No valid numbers entered = spin the whole active queue; otherwise spin
  // only among the songs whose numbers were typed in.
  const pool        = matchedSongs.length > 0 ? matchedSongs : songs;
  const canSpin      = pool.length > 0;
  const selectedSongs = pool;
  const n = selectedSongs.length || 1;
  const segAngle = 360 / n;

  const startSpin = () => {
    if (!canSpin || spinning) return;
    setWinner(null);
    const winnerIndex = Math.floor(Math.random() * n);
    const midAngle    = winnerIndex * segAngle + segAngle / 2;
    const currentMod  = ((rotation % 360) + 360) % 360;
    const desiredMod  = (360 - midAngle) % 360;
    let delta = desiredMod - currentMod;
    if (delta < 0) delta += 360;
    pendingWinnerRef.current = selectedSongs[winnerIndex];
    setSpinning(true);
    setRotation(r => r + 4 * 360 + delta); // a few full spins + land on winner
  };

  const handleTransitionEnd = (e) => {
    if (e.propertyName !== "transform" || !spinning) return;
    setSpinning(false);
    const w = pendingWinnerRef.current;
    setWinner(w);
    if (w) setTimeout(() => onOpenSong(w), 500);
  };

  const size = 190, cx = size / 2, cy = size / 2, r = size / 2 - 6;
  const polarToCartesian = (angleDeg) => {
    const rad = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };
  const wedgePath = (startAngle, endAngle) => {
    const start = polarToCartesian(endAngle);
    const end   = polarToCartesian(startAngle);
    const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
    return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{width: 360}} onClick={e => e.stopPropagation()}>
        <div className="flex flex-col items-center">
          <div className="w-full flex items-center justify-between mb-3">
            <div className="text-lg font-bold text-white">🎡 Spin the Wheel</div>
            <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">✕</button>
          </div>

          <div className="relative" style={{width: size, height: size}}>
            <div className="absolute left-1/2 -top-1 -translate-x-1/2 z-10"
              style={{width: 0, height: 0, borderLeft: "10px solid transparent", borderRight: "10px solid transparent", borderTop: "16px solid #f9a8d4"}}/>
            <svg width={size} height={size}
              style={{transform: `rotate(${rotation}deg)`, transition: "transform 2s cubic-bezier(.15,.65,.15,1)"}}
              onTransitionEnd={handleTransitionEnd}>
              {selectedSongs.map((s, i) => {
                const start = i * segAngle, end = (i + 1) * segAngle;
                const mid   = start + segAngle / 2;
                const labelPos = polarToCartesian(mid);
                const lx = cx + (labelPos.x - cx) * 0.6, ly = cy + (labelPos.y - cy) * 0.6;
                return (
                  <g key={s.id}>
                    <path d={wedgePath(start, end)} fill={AVATAR_COLORS[i % AVATAR_COLORS.length]} stroke="#0d0d18" strokeWidth="2"/>
                    <text x={lx} y={ly} fill="white" fontSize={showNames ? "10" : "14"} fontWeight="700" textAnchor="middle" dominantBaseline="middle">
                      {showNames ? (s.title || "").slice(0, 12) : `#${songToNumber[s.id]}`}
                    </text>
                  </g>
                );
              })}
              <circle cx={cx} cy={cy} r="10" fill="#0d0d18" stroke="#7c3aed" strokeWidth="2"/>
            </svg>
          </div>

          {winner ? (
            <div className="mt-5 text-center">
              <div className="text-sm text-gray-400">🎉 Landed on</div>
              <div className="text-lg font-bold text-violet-300">{winner.title}</div>
              <div className="text-xs text-gray-500 mt-1">Opening lyrics…</div>
            </div>
          ) : (
            <button onClick={startSpin} disabled={!canSpin || spinning}
              className="mt-5 px-6 py-2.5 rounded-xl text-sm font-bold bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 transition-all">
              {spinning ? "Spinning…" : "🎲 Spin!"}
            </button>
          )}

          {!spinning && !winner && (
            <div className="w-full mt-5 pt-4 border-t border-[#1e1e2e]">
              <p className="text-xs text-gray-500 mb-2">Optionally narrow it to up to 5 song numbers — otherwise it spins the whole active queue. Numbers are 1–{maxNumber}.</p>
              <div className="flex items-center gap-2 mb-2">
                {numberInputs.map((val, idx) => (
                  <input key={idx} type="number" inputMode="numeric" value={val}
                    onChange={(e) => {
                      const v = e.target.value;
                      setNumberInputs(prev => prev.map((x, i) => i === idx ? v : x));
                    }}
                    placeholder="#"
                    className="w-0 flex-1 min-w-0 text-center text-sm bg-[#1a1a2e] border border-[#2e2e44] rounded-lg py-2 text-gray-200 focus:border-violet-500 focus:outline-none"/>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-500 mb-2 cursor-pointer">
                <input type="checkbox" checked={showNames} onChange={(e)=>setShowNames(e.target.checked)} className="accent-violet-600"/>
                Show song names while spinning
              </label>
              <div className="text-xs text-gray-500">
                {matchedSongs.length > 0
                  ? <>Spinning: <span className="text-gray-300">{matchedSongs.map(s => showNames ? s.title : `#${songToNumber[s.id]}`).join(", ")}</span></>
                  : <>Spinning all {songs.length} active songs.</>}
                {invalidCount > 0 && (
                  <div className="text-amber-500 mt-1">{invalidCount} number{invalidCount > 1 ? "s" : ""} didn't match a song in the queue.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FolderView({folder,songs,onOpenSong,onRemove,onBack,onAddCustom,onEditSong,
  canBroadcast, isBroadcasting, onStartBroadcast, onStopBroadcast,
  broadcastModerator, followingBroadcast, onLeaveBroadcast, viewerCount,
  showToast, onPersistRequestToken, onRefresh}) {
  const [showRequestLink, setShowRequestLink] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const doRefresh = async () => {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  };
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 pt-3 sm:pt-5 pb-3 sm:pb-4 border-b border-[#1e1e2e]">
        <div className="flex items-center gap-3">
          <button onClick={onBack} title="Back" className="text-violet-400 hover:text-violet-300 text-lg">←</button>
          <div className="min-w-0 flex-1">
            <h2 className="text-base sm:text-xl font-bold text-white truncate flex items-center gap-2">
              <span className="truncate">📁 {folder.name}</span>
              {(isBroadcasting || broadcastModerator) && (
                <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse flex-shrink-0" title={isBroadcasting ? "You're broadcasting" : `${broadcastModerator.name} is broadcasting`} />
              )}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {songs.length} song{songs.length!==1?"s":""}
              {broadcastModerator && !isBroadcasting && (
                <span className="ml-2 text-red-400">· 📡 {broadcastModerator.name} is broadcasting</span>
              )}
              {isBroadcasting && <span className="ml-2 text-red-400">· 🔴 You are live</span>}
            </p>
          </div>

          {/* Broadcast controls */}
          {canBroadcast && !isBroadcasting && (
            <button onClick={onStartBroadcast}
              title="Start broadcasting — your song picks will sync to anyone who shared this folder"
              className="text-xs px-3 py-1.5 rounded-lg border border-red-500/40 text-red-400 hover:bg-red-600/10 transition-all flex-shrink-0">
              📡 <span className="hidden sm:inline">Start</span> Broadcast
            </button>
          )}
          {canBroadcast && isBroadcasting && (
            <div className="flex items-center gap-2 flex-shrink-0">
              {viewerCount > 0 && (
                <span className="text-xs text-green-400 font-medium">👥 {viewerCount}</span>
              )}
              <button onClick={onStopBroadcast}
                className="text-xs px-3 py-1.5 rounded-lg bg-red-600/20 border border-red-500 text-red-300 hover:bg-red-600/30 transition-all animate-pulse">
                ⏹ Stop
              </button>
            </div>
          )}
          {!canBroadcast && broadcastModerator && followingBroadcast && (
            <button onClick={onLeaveBroadcast}
              className="text-xs px-3 py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-gray-500 transition-all flex-shrink-0">
              Leave
            </button>
          )}

          {onRefresh && (
            <button onClick={doRefresh} disabled={refreshing}
              title="Refresh — pick up songs added via a Request Songs link"
              className={`text-xs px-2.5 py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-violet-500/50 hover:text-violet-300 transition-all flex-shrink-0 disabled:opacity-50 ${refreshing?"animate-spin":""}`}>
              🔄
            </button>
          )}

          {HAS_SUPABASE && (
            <button onClick={()=>setShowRequestLink(true)}
              title="Get a link for the audience to request songs — no account needed"
              className="text-xs px-3 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-400 hover:bg-emerald-600/10 transition-all flex-shrink-0">
              🎤 <span className="hidden sm:inline">Request Songs</span>
            </button>
          )}

          <button onClick={onAddCustom}
            title="Add your own lyrics"
            className="text-xs px-3 py-1.5 rounded-lg border border-violet-500/40 text-violet-400 hover:bg-violet-600/10 transition-all flex-shrink-0">
            ＋ <span className="hidden sm:inline">Add</span> Lyrics
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-5 space-y-2 sm:space-y-3">
        {songs.length===0&&(
          <div className="text-center py-16 text-gray-500">
            <div className="text-4xl mb-3">🎵</div>
            <p>No songs yet. Search & add, or tap <span className="text-violet-400 font-semibold">+ Add Lyrics</span> to add your own.</p>
          </div>
        )}
        {songs.map((song,i)=>(
          <div key={song.id} className="flex items-center justify-between gap-2 bg-[#1a1a2e] border border-[#2e2e44] rounded-xl px-3 sm:px-4 py-2.5 sm:py-3 hover:border-violet-500/40 transition-all min-w-0">
            <div className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer" onClick={()=>onOpenSong(song)}>
              <span className="text-lg sm:text-xl font-bold text-violet-800 w-5 sm:w-6 flex-shrink-0">{i+1}</span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-white truncate text-sm sm:text-base">
                  {song.title}
                  {song.type === "custom" && <span className="ml-1.5 text-xs text-violet-400">●</span>}
                  {song.customLyrics && song.type !== "custom" && <span className="ml-1.5 text-xs text-amber-400">✎</span>}
                </div>
                <div className="text-xs text-gray-400 truncate">{song.artist||song.singer}</div>
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {song.votes > 0 && (
                <span title="Audience votes — upvoted songs move up the queue"
                  className="text-xs text-pink-400 flex items-center gap-0.5 px-1.5">❤️ {song.votes}</span>
              )}
              {!(broadcastModerator && !isBroadcasting) && (
                <button onClick={()=>onEditSong(song)} title="Edit lyrics"
                  className="text-gray-600 hover:text-violet-400 text-sm px-1.5 transition-all">✎</button>
              )}
              <button onClick={()=>onRemove(folder.id,song.id)} title="Remove"
                className="text-gray-600 hover:text-red-400 text-sm px-1.5 transition-all">✕</button>
            </div>
          </div>
        ))}
      </div>
      {showRequestLink && (
        <RequestLinkModal folder={folder} onClose={()=>setShowRequestLink(false)}
          showToast={showToast} onPersistRequestToken={onPersistRequestToken}/>
      )}
    </div>
  );
}

// ─── Search Page ──────────────────────────────────────────────────────
function SearchPage({onOpenSong,folders,onAddToFolder,user,onSelectFolder,onCreateFolder,onShareFolder,onLogout,onAddCustomLyrics,onOpenSettings,onDeleteFolder,onRenameFolder,onStartBroadcast}) {
  const username = user.username;
  const [query,setQuery]              = React.useState("");
  const [filterBy,setFilterBy]        = React.useState("title");
  const [language, setLanguage]       = React.useState("Tamil"); // default Tamil per request
  const [creatingFolder,setCreating]  = React.useState(false);
  const [newFolderName,setNewName]    = React.useState("");
  const [showMenu,setShowMenu]        = React.useState(null);
  const [inlineNewFolder, setInlineNewFolder] = React.useState(null);
  const [page, setPage]               = React.useState(0);
  const resultsTopRef = React.useRef(null);

  // "Movie" maps to an album lookup; "Singer"/"Composer" both map to an
  // artist lookup (JioSaavn doesn't distinguish the two — a composer is just
  // an artist credit with a different role).
  const mode = filterBy === "movie" ? "movie" : (filterBy === "singer" || filterBy === "composer") ? "artist" : "title";
  const { results: allResults, loading, artistNotFound, catalogError, artistActive,
          artistPage, setArtistPage, artistTotalPages, artistHasMore, artistTotal, languageFilterUnavailable } =
    useCatalogSearch({ query, mode, language });

  // Reset to page 0 whenever the query/filter/language changes
  React.useEffect(()=>{ setPage(0); }, [query, filterBy, language]);

  // Title/Movie: slice the returned pool client-side (existing behavior).
  // Singer/Composer (artist mode): the hook already hands back one page at a
  // time, so just render it directly and drive pagination off the hook.
  const liveResults = mode === "artist" ? allResults
    : allResults.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages  = mode === "artist" ? 1 : Math.max(1, Math.ceil(allResults.length / PAGE_SIZE));
  const hasMore     = page + 1 < totalPages;

  // Scroll to top of results when page changes
  React.useEffect(()=>{
    if (page > 0 && resultsTopRef.current) {
      resultsTopRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [page]);

  const handleCreateFolder = () => {
    if (newFolderName.trim()) {
      onCreateFolder(newFolderName.trim());
      setNewName(""); setCreating(false);
    }
  };

  const handleCreateAndAdd = async (song, name) => {
    if (!name.trim()) return;
    const newF = await onCreateFolder(name.trim());
    if (newF) onAddToFolder(newF.id, song);
    setInlineNewFolder(null);
    setShowMenu(null);
  };

  const addBtn = (song) => (
    <div className="relative">
      <button onClick={e=>{e.stopPropagation();setShowMenu(showMenu===song.id?null:song.id);setInlineNewFolder(null);}}
        className="text-xs px-2 py-1.5 border border-[#2e2e44] hover:border-violet-500 text-gray-400 hover:text-violet-400 rounded-lg transition-all">📁</button>
      {showMenu===song.id && (
        <div className="absolute right-0 top-full mt-1 bg-[#1a1a2e] border border-[#2e2e44] rounded-xl shadow-xl z-50 min-w-48" onClick={e=>e.stopPropagation()}>
          {folders.length===0 && <div className="px-4 py-3 text-xs text-gray-500">No folders yet.</div>}
          {folders.map(f=>(
            <button key={f.id} onClick={()=>{onAddToFolder(f.id,song);setShowMenu(null);}}
              className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-violet-600/20 hover:text-violet-300 first:rounded-t-xl transition-all">
              📁 {f.name}
            </button>
          ))}
          <div className="border-t border-[#2e2e44]">
            {inlineNewFolder?.songId === song.id ? (
              <div className="px-3 py-2.5 flex gap-1">
                <input autoFocus value={inlineNewFolder.name}
                  onChange={e=>setInlineNewFolder({songId:song.id,name:e.target.value})}
                  onKeyDown={e=>{
                    if(e.key==="Enter") handleCreateAndAdd(song, inlineNewFolder.name);
                    if(e.key==="Escape") setInlineNewFolder(null);
                  }}
                  placeholder="New folder name…"
                  className="flex-1 bg-[#0d0d18] border border-violet-500/50 rounded-md px-2 py-1 text-xs text-white placeholder-gray-600"/>
                <button onClick={()=>handleCreateAndAdd(song, inlineNewFolder.name)}
                  className="text-xs px-2 py-1 bg-violet-600 hover:bg-violet-700 text-white rounded-md font-semibold">✓</button>
              </div>
            ) : (
              <button onClick={()=>setInlineNewFolder({songId:song.id, name:""})}
                className="w-full text-left px-4 py-2.5 text-sm text-violet-400 hover:bg-violet-600/20 last:rounded-b-xl transition-all">
                + Create new folder
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const hasQuery = query.trim().length >= 2;
  const isMobile = useIsMobile();

  const [showAccount, setShowAccount] = React.useState(false);
  const [openFolderMenu, setOpenFolderMenu] = React.useState(null);

  const searchInput = (
    <div className="max-w-xl mx-auto w-full min-w-0">
      <div className="flex gap-1.5 sm:gap-2 w-full min-w-0">
        <div className="relative flex-1 min-w-0">
          <input value={query} onChange={e=>setQuery(e.target.value)} autoFocus={!isMobile}
            placeholder={`Search by ${filterBy}…`}
            className={`w-full bg-[#1a1a2e] border border-[#2e2e44] rounded-xl pl-3 sm:pl-4 pr-9 ${isMobile?"py-2.5":"py-3"} text-white placeholder-gray-500 text-sm transition-all ${isMobile?"":"text-center"}`} />
          {query && (
            <button onClick={()=>setQuery("")}
              title="Clear search · back to folders"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full text-gray-500 hover:text-white hover:bg-[#2a2a3e] transition-all text-sm">
              ✕
            </button>
          )}
        </div>
        <select value={filterBy} onChange={e=>setFilterBy(e.target.value)}
          style={{maxWidth: isMobile ? "92px" : "120px"}}
          className={`flex-shrink-0 bg-[#1a1a2e] border border-[#2e2e44] rounded-xl px-2 ${isMobile?"py-2.5":"py-3"} text-gray-300 text-xs sm:text-sm cursor-pointer`}>
          <option value="title">Title</option>
          <option value="movie">Movie</option>
          <option value="singer">Singer</option>
          <option value="composer">Composer</option>
        </select>
      </div>
      {/* Language pills — not meaningful for Movie mode (a soundtrack's own language wins) */}
      {filterBy !== "movie" && (
        <div className={`flex flex-wrap gap-1.5 mt-2 ${isMobile?"justify-start":"justify-center"}`}>
          {LANGUAGES.map(l => (
            <button key={l} onClick={()=>setLanguage(l)}
              className={`lang-pill text-xs px-2.5 py-1 rounded-full border font-medium transition-all ${language===l?"active border-violet-600":"border-[#2a2a3e] text-gray-400 hover:border-gray-500"}`}>
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden" onClick={()=>{setShowMenu(null); setShowAccount(false); setOpenFolderMenu(null);}}>
      {/* Top bar — logo + account widget */}
      <div className="flex items-center justify-between px-4 sm:px-6 pt-3 sm:pt-4 pb-2 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg">🎸</span>
          <span className="text-sm font-bold text-white">JamBook</span>
          <span className="text-xs text-gray-600 hidden sm:inline">· ✨ The Vibe is Here</span>
        </div>
        <div className="relative" onClick={e=>e.stopPropagation()}>
          <button onClick={()=>setShowAccount(v=>!v)}
            className="flex items-center gap-2 px-2 py-1 rounded-full border border-[#2a2a3e] hover:border-violet-500 transition-all">
            <Avatar username={username} size={28}/>
            <span className="text-xs text-gray-300 pr-1 hidden sm:inline">{username}</span>
          </button>
          {showAccount && (
            <div className="absolute right-0 top-full mt-1 bg-[#1a1a2e] border border-[#2e2e44] rounded-xl shadow-xl z-50 min-w-52 overflow-hidden">
              <div className="px-4 py-3 border-b border-[#2e2e44]">
                <div className="text-sm font-semibold text-white">{username}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {user.isGuest ? "Guest mode — nothing saved yet" : `${folders.length} folder${folders.length!==1?"s":""}`}
                </div>
              </div>
              {user.isGuest ? (
                <button onClick={onLogout}
                  className="w-full text-left px-4 py-2.5 text-sm text-violet-300 hover:bg-violet-600/20 transition-all">
                  ✨ Sign up to save this
                </button>
              ) : (
                <>
                  <button onClick={()=>{ setShowAccount(false); onOpenSettings && onOpenSettings(); }}
                    className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-violet-600/20 hover:text-violet-300 transition-all">
                    ⚙ Settings
                  </button>
                  <button onClick={onLogout}
                    className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-all">
                    ⎋ Sign out
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Hero — desktop only (mobile gets the bottom-fixed search) */}
      {!isMobile && (
        <div className="px-6 pt-4 pb-6 border-b border-[#1a1a2a] flex-shrink-0">
          <div className="max-w-2xl mx-auto text-center">
            <h1 className="text-3xl font-bold text-white mb-1">
              <span className="text-violet-400">{username}</span> is Jamming! 🎶
            </h1>
            <p className="text-gray-500 text-sm mb-6">Start the Vibe, Let it Flow 🎶</p>
            {searchInput}
          </div>
        </div>
      )}

      {/* Mobile compact greeting */}
      {isMobile && (
        <div className="px-4 pb-3 flex-shrink-0">
          <h1 className="text-xl font-bold text-white">
            <span className="text-violet-400">{username}</span> is Jamming! 🎶
          </h1>
        </div>
      )}

      {/* Static nav strip — visible whenever a search is active.
          Lives OUTSIDE the scroll container so it doesn't scroll away.
          Horizontally scrollable so a long folder list never wraps on mobile. */}
      {hasQuery && (
        <div className="flex-shrink-0 px-3 sm:px-6 py-2 border-b border-[#1a1a2a] bg-[#0f0f14] overflow-x-auto whitespace-nowrap chip-strip">
          <div className="flex items-center gap-2 max-w-3xl mx-auto">
            <button onClick={()=>setQuery("")}
              className="text-xs px-2.5 py-1 rounded-full border border-[#2e2e44] text-gray-300 hover:border-violet-500 hover:text-violet-300 transition-all flex-shrink-0 font-medium">
              ← Home
            </button>
            {folders.length > 0 && (
              <>
                <span className="text-xs text-gray-700 flex-shrink-0">·</span>
                {folders.map(f => (
                  <button key={f.id} onClick={()=>onSelectFolder(f.id)}
                    title={`Open ${f.name}`}
                    className="text-xs px-2.5 py-1 rounded-full border border-[#2a2a3e] text-gray-300 hover:border-violet-500 hover:text-violet-300 transition-all flex-shrink-0 max-w-[150px] truncate">
                    📁 {f.name}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      <div className={`flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-6 ${isMobile?"pb-28":""}`}>
        {/* Live results — only when searching */}
        {hasQuery && (
          <div ref={resultsTopRef} className="max-w-3xl mx-auto mb-8">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">🎵 Search Results</span>
              {loading
                ? <div className="w-3 h-3 border border-violet-500 border-t-transparent rounded-full animate-spin"/>
                : mode === "artist"
                  ? (artistTotalPages && <span className="text-xs px-2 py-0.5 rounded-full live-badge">{artistTotal} total</span>)
                  : <span className="text-xs px-2 py-0.5 rounded-full live-badge">{allResults.length} total</span>}
              {mode !== "artist" && totalPages > 1 && <span className="text-xs text-gray-600">· Page {page+1} of {totalPages}</span>}
              {mode === "artist" && (artistTotalPages ? artistTotalPages > 1 : artistPage > 0) && (
                <span className="text-xs text-gray-600">· Page {artistPage+1}{artistTotalPages ? ` of ${artistTotalPages}` : ""}</span>
              )}
            </div>
            {!loading && mode === "artist" && languageFilterUnavailable && (
              <p className="text-xs text-amber-500/80 py-2">Language filtering isn't available for this artist right now — try "All", or search again in a bit.</p>
            )}
            {!loading && liveResults.length===0 && !(mode === "artist" && languageFilterUnavailable) && (
              <p className="text-xs text-gray-600 py-2">
                {catalogError
                  ? "Search is temporarily unavailable — please try again in a moment."
                  : mode === "artist" && artistNotFound
                    ? `No artist found matching "${query.trim()}".`
                    : "No songs found."}
              </p>
            )}
            <div className="space-y-2">
              {liveResults.map(song=>(
                <div key={song.id} className="bg-[#1a1a2e] border border-[#1e2a1e] rounded-xl px-4 py-3 hover:border-green-500/30 transition-all">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1 cursor-pointer min-w-0 mr-3" onClick={()=>onOpenSong(song)}>
                      {song.cover && <img src={song.cover} alt="" className="w-10 h-10 rounded-lg flex-shrink-0 object-cover"/>}
                      <div className="min-w-0">
                        <div className="font-semibold text-white truncate">{song.title}</div>
                        <div className="text-xs text-gray-400 truncate">{song.artist} · {song.album}</div>
                      </div>
                    </div>
                    <div className="flex gap-2 items-center flex-shrink-0">
                      <button onClick={()=>onOpenSong(song)} className="text-xs px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg font-medium transition-all">Open</button>
                      {addBtn(song)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-5 pt-4 border-t border-[#1a1a2a]">
                <button
                  onClick={()=>setPage(p=>Math.max(0,p-1))}
                  disabled={page === 0 || loading}
                  className={`text-xs px-4 py-2 rounded-lg border transition-all ${page===0||loading?"border-[#1e1e2e] text-gray-700 cursor-not-allowed":"border-[#2e2e44] text-gray-300 hover:border-violet-500 hover:text-violet-400"}`}>
                  ← Previous
                </button>
                <span className="text-xs text-gray-500">Page {page+1} of {totalPages}</span>
                <button
                  onClick={()=>setPage(p=>p+1)}
                  disabled={!hasMore || loading}
                  className={`text-xs px-4 py-2 rounded-lg border transition-all ${!hasMore||loading?"border-[#1e1e2e] text-gray-700 cursor-not-allowed":"border-[#2e2e44] text-gray-300 hover:border-violet-500 hover:text-violet-400"}`}>
                  Next →
                </button>
              </div>
            )}

            {/* Artist-mode pagination (Singer/Composer) — pages through the API directly */}
            {mode === "artist" && artistActive && (artistTotalPages ? artistTotalPages > 1 : (artistPage > 0 || artistHasMore)) && (
              <div className="flex items-center justify-between mt-5 pt-4 border-t border-[#1a1a2a]">
                <button
                  onClick={()=>setArtistPage(p=>Math.max(0,p-1))}
                  disabled={artistPage === 0 || loading}
                  className={`text-xs px-4 py-2 rounded-lg border transition-all ${artistPage===0||loading?"border-[#1e1e2e] text-gray-700 cursor-not-allowed":"border-[#2e2e44] text-gray-300 hover:border-violet-500 hover:text-violet-400"}`}>
                  ← Previous
                </button>
                <span className="text-xs text-gray-500">
                  {artistTotalPages ? `Page ${artistPage+1} of ${artistTotalPages}` : `Page ${artistPage+1}`}
                </span>
                <button
                  onClick={()=>setArtistPage(p=>p+1)}
                  disabled={(artistTotalPages ? artistPage+1 >= artistTotalPages : !artistHasMore) || loading}
                  className={`text-xs px-4 py-2 rounded-lg border transition-all ${(artistTotalPages ? artistPage+1>=artistTotalPages : !artistHasMore)||loading?"border-[#1e1e2e] text-gray-700 cursor-not-allowed":"border-[#2e2e44] text-gray-300 hover:border-violet-500 hover:text-violet-400"}`}>
                  Next →
                </button>
              </div>
            )}
          </div>
        )}

        {/* Folders grid — always shown when not actively searching, or below results */}
        {!hasQuery && (
          <div className="max-w-5xl mx-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">My Folders</h2>
              <span className="text-xs text-gray-600">{folders.length} folder{folders.length!==1?"s":""}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Existing folders */}
              {folders.map(f => (
                <div key={f.id} onClick={()=>onSelectFolder(f.id)}
                  className="folder-card bg-[#1a1a2e] border border-[#2a2a3e] rounded-2xl p-5 cursor-pointer transition-all relative">
                  <div className="flex items-start justify-between mb-3">
                    <div className="text-4xl">📁</div>
                    <div className="relative" onClick={e=>e.stopPropagation()}>
                      <button
                        onClick={()=>setOpenFolderMenu(openFolderMenu===f.id?null:f.id)}
                        title="Folder actions"
                        className="text-gray-400 hover:text-violet-300 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[#0d0d18] transition-all text-base">
                        ⋮
                      </button>
                      {openFolderMenu===f.id && (
                        <div className="absolute right-0 top-full mt-1 bg-[#0d0d18] border border-[#2e2e44] rounded-xl shadow-xl z-50 min-w-44 overflow-hidden">
                          <button
                            onClick={()=>{onShareFolder(f); setOpenFolderMenu(null);}}
                            className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-violet-600/20 hover:text-violet-300 transition-all">
                            ↗ Share
                          </button>
                          {onStartBroadcast && (
                            <button
                              onClick={()=>{onStartBroadcast(f.id); setOpenFolderMenu(null);}}
                              className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/15 transition-all border-t border-[#2e2e44]">
                              📡 Start Broadcast
                            </button>
                          )}
                          {onRenameFolder && (
                            <button
                              onClick={()=>{
                                const name = window.prompt("Rename folder", f.name);
                                if (name && name.trim() && name.trim() !== f.name) onRenameFolder(f.id, name.trim());
                                setOpenFolderMenu(null);
                              }}
                              className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-violet-600/20 hover:text-violet-300 transition-all border-t border-[#2e2e44]">
                              ✏ Rename
                            </button>
                          )}
                          {onDeleteFolder && (
                            <button
                              onClick={()=>{
                                if (window.confirm(`Delete folder "${f.name}"? This cannot be undone.`)) {
                                  onDeleteFolder(f.id);
                                }
                                setOpenFolderMenu(null);
                              }}
                              className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/15 transition-all border-t border-[#2e2e44]">
                              🗑 Delete
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="text-base font-bold text-white truncate mb-1">{f.name}</div>
                  <div className="text-xs text-gray-500">{(f.songs?.length||0)} song{(f.songs?.length||0)!==1?"s":""}</div>
                </div>
              ))}

              {/* Create new folder card */}
              {!creatingFolder ? (
                <div onClick={()=>setCreating(true)}
                  className="bg-[#0d0d18] border-2 border-dashed border-[#2a2a3e] hover:border-violet-500 hover:bg-violet-600/5 rounded-2xl p-5 cursor-pointer transition-all flex flex-col items-center justify-center min-h-[140px]">
                  <div className="text-4xl text-violet-500 mb-2">+</div>
                  <div className="text-sm font-semibold text-violet-400">New Folder</div>
                  <div className="text-xs text-gray-600 mt-1">Create a jam session</div>
                </div>
              ) : (
                <div className="bg-[#1a1a2e] border-2 border-violet-500 rounded-2xl p-5 flex flex-col justify-center min-h-[140px]">
                  <input autoFocus value={newFolderName} onChange={e=>setNewName(e.target.value)}
                    onKeyDown={e=>{ if(e.key==="Enter") handleCreateFolder(); if(e.key==="Escape"){setCreating(false);setNewName("");} }}
                    placeholder="Folder name…"
                    className="w-full bg-[#0d0d18] border border-violet-500/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 mb-2"/>
                  <div className="flex gap-2">
                    <button onClick={handleCreateFolder}
                      className="flex-1 text-xs py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-all font-semibold">Create</button>
                    <button onClick={()=>{setCreating(false);setNewName("");}}
                      className="text-xs py-1.5 px-3 border border-[#2a2a3e] text-gray-400 hover:text-white rounded-lg transition-all">Cancel</button>
                  </div>
                </div>
              )}

              {/* Add your own lyrics card */}
              {folders.length > 0 && (
                <div onClick={onAddCustomLyrics}
                  className="bg-[#0d0d18] border-2 border-dashed border-amber-700/40 hover:border-amber-500 hover:bg-amber-600/5 rounded-2xl p-5 cursor-pointer transition-all flex flex-col items-center justify-center min-h-[140px]">
                  <div className="text-4xl text-amber-500 mb-2">🎵</div>
                  <div className="text-sm font-semibold text-amber-400">Add Lyrics</div>
                  <div className="text-xs text-gray-600 mt-1">Paste your own song</div>
                </div>
              )}
            </div>

            {/* Helpful empty hint when no folders at all */}
            {folders.length===0 && !creatingFolder && (
              <p className="text-center text-xs text-gray-600 mt-6">
                Tap <span className="text-violet-400 font-semibold">+ New Folder</span> to create your first jam session.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Mobile-fixed search at bottom — thumb-reach */}
      {isMobile && (
        <div className="mobile-search-bar">{searchInput}</div>
      )}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────
function Sidebar({user,folders,activeFolderId,onSelectFolder,onCreateFolder,onDeleteFolder,onRenameFolder,onShareFolder,onShowImport,activeView,onGoSearch,collapsed,onToggleCollapse,onLogout}) {
  const [newName,setNewName]   = React.useState("");
  const [creating,setCreating] = React.useState(false);

  const create = () => { if(newName.trim()){onCreateFolder(newName.trim());setNewName("");setCreating(false);} };

  if (collapsed) return (
    <div className="sidebar-transition w-12 flex-shrink-0 bg-[#0d0d18] border-r border-[#1a1a2a] flex flex-col items-center py-3 gap-3">
      <button onClick={onToggleCollapse} className="text-gray-500 hover:text-violet-400 text-xl w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#1a1a2e] transition-all">›</button>
      <div className="w-px h-4 bg-[#2a2a3a]"/>
      <button onClick={onGoSearch} title="Search" className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all text-base ${activeView==="search"?"bg-violet-600/20 text-violet-400":"text-gray-500 hover:bg-[#1a1a2e] hover:text-white"}`}>🔍</button>
      <div className="w-px h-4 bg-[#2a2a3a]"/>
      {folders.map(f=>(
        <button key={f.id} onClick={()=>onSelectFolder(f.id)} title={f.name}
          className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all text-sm ${activeFolderId===f.id&&activeView==="folder"?"bg-violet-600/20 text-violet-400":"text-gray-500 hover:bg-[#1a1a2e] hover:text-white"}`}>📁</button>
      ))}
      <div className="mt-auto"><Avatar username={user.username} size={30}/></div>
    </div>
  );

  return (
    <div className="sidebar-transition w-60 flex-shrink-0 bg-[#0d0d18] border-r border-[#1a1a2a] flex flex-col h-full">
      <div className="px-4 py-4 border-b border-[#1a1a2a] flex items-center justify-between">
        <div>
          <div className="text-base font-bold text-white">🎸 JamBook</div>
          <div className="text-xs text-gray-500 pl-5">✨ The Vibe is Here</div>
        </div>
        <button onClick={onToggleCollapse} className="text-gray-600 hover:text-gray-300 text-xl w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[#1a1a2e] transition-all">‹</button>
      </div>
      <nav className="px-3 pt-3 space-y-1">
        <button onClick={onGoSearch}
          className={`w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${activeView==="search"?"bg-violet-600/20 text-violet-300 border border-violet-600/30":"text-gray-400 hover:bg-[#1a1a2e] hover:text-white"}`}>
          🔍 Search Songs
        </button>
      </nav>
      <div className="px-3 pt-4 pb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">My Folders</span>
        <div className="flex gap-1">
          <button onClick={onShowImport} title="Import shared" className="text-gray-500 hover:text-violet-400 text-xs px-1.5 py-1 rounded transition-all">⬇</button>
          <button onClick={()=>setCreating(v=>!v)} className="text-violet-400 hover:text-violet-300 text-xl leading-none w-6 h-6 flex items-center justify-center">+</button>
        </div>
      </div>
      {creating&&(
        <div className="px-3 mb-2">
          <input autoFocus value={newName} onChange={e=>setNewName(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter")create();if(e.key==="Escape")setCreating(false);}}
            placeholder="Folder name…"
            className="w-full bg-[#1a1a2e] border border-violet-500/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600"/>
          <button onClick={create} className="mt-1.5 w-full text-xs py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-all">Create</button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
        {folders.length===0&&!creating&&<div className="text-xs text-gray-600 px-3 py-2">No folders yet. Tap + to create one.</div>}
        {folders.map(f=>(
          <div key={f.id}
            className={`folder-card group flex items-center justify-between px-3 py-2.5 rounded-lg border transition-all cursor-pointer ${activeFolderId===f.id&&activeView==="folder"?"bg-violet-600/20 border-violet-600/30 text-violet-300":"border-transparent text-gray-400 hover:text-white"}`}
            onClick={()=>onSelectFolder(f.id)}>
            <span className="text-sm flex items-center gap-2 min-w-0">
              <span>📁</span>
              <span className="truncate">{f.name}</span>
              <span className="text-xs text-gray-600 flex-shrink-0">({f.songs?.length||0})</span>
              {f.shareCode&&<span className="text-xs text-violet-600">↗</span>}
            </span>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
              <button onClick={e=>{e.stopPropagation();onShareFolder(f);}} title="Share" className="text-gray-600 hover:text-violet-400 text-xs px-1 transition-all">↗</button>
              {onRenameFolder && (
                <button onClick={e=>{
                  e.stopPropagation();
                  const name = window.prompt("Rename folder", f.name);
                  if (name && name.trim() && name.trim() !== f.name) onRenameFolder(f.id, name.trim());
                }} title="Rename" className="text-gray-600 hover:text-violet-400 text-xs px-1 transition-all">✏</button>
              )}
              <button onClick={e=>{e.stopPropagation();onDeleteFolder(f.id);}} className="text-gray-600 hover:text-red-400 text-xs px-1 transition-all">✕</button>
            </div>
          </div>
        ))}
      </div>
      <div className="px-4 py-4 border-t border-[#1a1a2a]">
        <div className="flex items-center gap-3">
          <Avatar username={user.username} size={36}/>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white truncate">{user.username}</div>
            <div className="text-xs text-gray-500">{folders.length} folder{folders.length!==1?"s":""}</div>
          </div>
          <button onClick={onLogout} title="Sign out" className="text-xs text-gray-600 hover:text-red-400 transition-all px-1.5 py-1 rounded hover:bg-red-900/10">⎋</button>
        </div>
      </div>
    </div>
  );
}

// ─── Audience Request Page ─────────────────────────────────────────────
// Fully standalone — no login, no sidebar, no other app state. Reached via
// ?request=<token>. Anyone with the link can search and add a song straight
// into the moderator's live folder; they never see the rest of the app.
const REQUEST_FILTERS = [
  { value: "title",  label: "Song Title" },
  { value: "movie",  label: "Movie" },
  { value: "artist", label: "Artist" },
];

// Every word in the query must appear as a WHOLE word in `field` — plain
// substring matching would let "singam" match "Singamalai" (a different
// movie that merely starts with the same letters).
function fieldMatchesWholeWords(field, query) {
  const qTokens = normalizeForMatch(query).split(" ").filter(Boolean);
  if (!qTokens.length) return true;
  const fieldTokens = new Set(normalizeForMatch(field).split(" ").filter(Boolean));
  return qTokens.every(t => fieldTokens.has(t));
}

function RequestSongPage({ token }) {
  const [folder, setFolder]         = React.useState(undefined); // undefined=loading, null=not found
  const [query, setQuery]           = React.useState("");
  const [filterBy, setFilterBy]     = React.useState("title");
  const [language, setLanguage]     = React.useState("Tamil");
  const [addedIds, setAddedIds]     = React.useState(() => new Set());
  const [addingId, setAddingId]     = React.useState(null);
  const [votingId, setVotingId]     = React.useState(null);
  // Which songs *this device* has upvoted on this request link — scoped per
  // token so voting on one session's link doesn't bleed into another's.
  const votedKey = `jb_voted_${token}`;
  const [votedIds, setVotedIds]     = React.useState(() => new Set(LS.get(votedKey, [])));
  const [toast, showToast]          = useToast();

  const { results, loading, artistNotFound, catalogError, artistActive,
          artistPage, setArtistPage, artistTotalPages, artistHasMore, artistTotal, languageFilterUnavailable } =
    useCatalogSearch({ query, mode: filterBy, language });

  const refreshFolder = React.useCallback(async () => {
    const f = await fetchFolderByRequestToken(token);
    if (f) setFolder(f); else setFolder(prev => prev === undefined ? null : prev);
  }, [token]);

  React.useEffect(() => {
    refreshFolder();
    // Poll so the "already added" list stays fresh as other people in the
    // audience request songs too — no realtime channel for this bare page.
    const id = setInterval(refreshFolder, 10000);
    return () => clearInterval(id);
  }, [refreshFolder]);

  // Songs already in the session queue — from the host, or from anyone else
  // using this same request link — so we can flag them in search results too.
  // Matched by name+artist+movie rather than id, since the same song can turn
  // up under a different id per source (Spotify vs JioSaavn vs iTunes).
  const queuedKeys    = React.useMemo(() => new Set((folder?.songs || []).map(songMatchKey)), [folder]);
  const completedKeys = React.useMemo(() => new Set((folder?.songs || []).filter(s => s.completed).map(songMatchKey)), [folder]);

  const handleAdd = async (song) => {
    if (queuedKeys.has(songMatchKey(song))) {
      showToast(`"${song.title}" is already in the queue`);
      return;
    }
    setAddingId(song.id);
    const res = await addSongViaRequestToken(token, song);
    setAddingId(null);
    if (res.ok) {
      setAddedIds(prev => new Set(prev).add(song.id));
      showToast(res.alreadyAdded ? "Already in the queue" : `Requested "${song.title}"!`);
      refreshFolder();
    } else {
      showToast(res.error || "Couldn't add — try again");
    }
  };

  // Toggle: tap the heart to upvote, tap again to retract. Upvoted songs get
  // re-sorted to the top of the real session queue server-side, not just
  // reordered in this view.
  const applyVoteLocally = (songId, delta) => {
    setFolder(prev => prev && {
      ...prev,
      songs: prev.songs.map(s => s.id === songId ? { ...s, votes: Math.max(0, (s.votes || 0) + delta) } : s),
    });
  };
  const setVotedLocally = (songId, voted) => {
    setVotedIds(prev => {
      const next = new Set(prev);
      voted ? next.add(songId) : next.delete(songId);
      LS.set(votedKey, [...next]);
      return next;
    });
  };

  const handleVote = async (song) => {
    if (votingId === song.id) return; // already mid-flight for this song
    const alreadyVoted = votedIds.has(song.id);
    const direction = alreadyVoted ? -1 : 1;

    // Optimistic: heart and count flip the instant you tap, before the
    // network round trip even starts — that round trip is what was making
    // votes feel unresponsive enough to invite repeat taps. Reconciled with
    // the real server state (and true queue order) once the write lands;
    // rolled back if it fails.
    setVotedLocally(song.id, !alreadyVoted);
    applyVoteLocally(song.id, direction);
    setVotingId(song.id);

    const res = await voteForSong(token, song.id, direction);
    setVotingId(null);
    if (res.ok) {
      refreshFolder();
    } else {
      setVotedLocally(song.id, alreadyVoted);
      applyVoteLocally(song.id, -direction);
      showToast(res.error || "Couldn't vote — try again");
    }
  };

  if (folder === undefined) {
    return (
      <div className="auth-bg min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin"/>
      </div>
    );
  }

  if (folder === null) {
    return (
      <div className="auth-bg min-h-screen flex flex-col items-center justify-center text-center px-6">
        <div className="text-4xl mb-3">🔗</div>
        <h1 className="text-lg font-bold text-white mb-1">Request link not found</h1>
        <p className="text-sm text-gray-500">This link may be mistyped, or the session no longer exists.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen md:h-screen flex flex-col md:overflow-hidden">
      <div className="px-4 sm:px-6 pt-6 pb-4 border-b border-[#1e1e2e] text-center flex-shrink-0">
        <div className="text-2xl mb-1">🎤</div>
        <h1 className="text-base sm:text-lg font-bold text-white">Requesting songs for</h1>
        <div className="text-sm font-semibold text-violet-300">📁 {folder.name}</div>
        <p className="text-xs text-gray-500 mt-1">Search a song and tap Add — it lands straight in the session queue.</p>
      </div>

      <div className="flex-1 overflow-y-auto md:overflow-hidden md:min-h-0 px-4 sm:px-6 py-4">
        <div className="max-w-5xl mx-auto w-full md:h-full flex flex-col md:flex-row gap-6">
          {/* ── Left: request a song ─────────────────────────────────── */}
          <div className="md:flex-1 md:min-h-0 md:min-w-0 flex flex-col">
            <div className="flex flex-wrap gap-1.5 mb-2 justify-center">
              {REQUEST_FILTERS.map(f => (
                <button key={f.value} onClick={()=>setFilterBy(f.value)}
                  className={`lang-pill text-xs px-2.5 py-1 rounded-full border font-medium transition-all ${filterBy===f.value?"active border-violet-600":"border-[#2a2a3e] text-gray-400 hover:border-gray-500"}`}>
                  {f.label}
                </button>
              ))}
            </div>
            <input value={query} onChange={e=>setQuery(e.target.value)} autoFocus
              placeholder={filterBy==="movie" ? "Search by movie name…" : filterBy==="artist" ? "Search by artist name…" : "Search for a song…"}
              className="w-full bg-[#1a1a2e] border border-[#2e2e44] rounded-xl px-4 py-3 text-white placeholder-gray-500 text-sm text-center focus:border-violet-500 focus:outline-none"/>
            {filterBy !== "movie" && (
              <div className="flex flex-wrap gap-1.5 mt-2 justify-center">
                {LANGUAGES.map(l => (
                  <button key={l} onClick={()=>setLanguage(l)}
                    className={`lang-pill text-xs px-2.5 py-1 rounded-full border font-medium transition-all ${language===l?"active border-violet-600":"border-[#2a2a3e] text-gray-400 hover:border-gray-500"}`}>
                    {l}
                  </button>
                ))}
              </div>
            )}
            {filterBy === "movie" && (
              <p className="text-xs text-gray-600 text-center mt-2">Shows every song from that movie's soundtrack.</p>
            )}
            {filterBy === "artist" && (
              <p className="text-xs text-gray-600 text-center mt-2">Browse an artist's songs, page by page — pick a language to narrow it down.</p>
            )}

            <div className="md:flex-1 md:min-h-0 md:overflow-y-auto md:pr-1">
              {loading && <div className="flex justify-center py-8"><Spinner/></div>}
              {!loading && filterBy === "artist" && languageFilterUnavailable && (
                <p className="text-xs text-amber-500/80 text-center py-2">Language filtering isn't available for this artist right now — try "All", or search again in a bit.</p>
              )}
              {!loading && query.trim().length >= 2 && results.length === 0 && !(filterBy === "artist" && languageFilterUnavailable) && (
                <p className="text-xs text-gray-600 text-center py-6">
                  {catalogError
                    ? "Search is temporarily unavailable — please try again in a moment."
                    : filterBy === "artist" && artistNotFound
                      ? `No artist found matching "${query.trim()}".`
                      : filterBy !== "title"
                        ? `No songs found for that ${filterBy}.`
                        : "No songs found."}
                </p>
              )}

              <div className="space-y-2 mt-4">
                {results.slice(0, 25).map(song => {
                  const key = songMatchKey(song);
                  const completed = completedKeys.has(key);
                  const added = !completed && (addedIds.has(song.id) || queuedKeys.has(key));
                  return (
                    <div key={song.id} className="bg-[#1a1a2e] border border-[#2a2a3e] rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {song.cover && <img src={song.cover} alt="" className="w-10 h-10 rounded-lg flex-shrink-0 object-cover"/>}
                        <div className="min-w-0">
                          <div className="font-semibold text-white truncate text-sm">{song.title}</div>
                          <div className="text-xs text-gray-400 truncate">{song.artist} · {song.album}</div>
                        </div>
                      </div>
                      <button onClick={()=>handleAdd(song)} disabled={completed || added || addingId === song.id}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all flex-shrink-0 disabled:cursor-not-allowed ${completed ? "bg-gray-700/30 text-gray-400 border border-gray-600/40" : added ? "bg-emerald-600/20 text-emerald-400 border border-emerald-600/40" : "bg-violet-600 hover:bg-violet-700 text-white"}`}>
                        {completed ? "✓ Completed" : added ? "✓ Added" : addingId === song.id ? "…" : "➕ Add"}
                      </button>
                    </div>
                  );
                })}
              </div>

              {artistActive && (artistTotalPages ? artistTotalPages > 1 : (artistPage > 0 || artistHasMore)) && (
                <div className="flex items-center justify-between mt-5 pt-4 border-t border-[#1a1a2a]">
                  <button
                    onClick={()=>setArtistPage(p=>Math.max(0,p-1))}
                    disabled={artistPage === 0 || loading}
                    className={`text-xs px-4 py-2 rounded-lg border transition-all ${artistPage===0||loading?"border-[#1e1e2e] text-gray-700 cursor-not-allowed":"border-[#2e2e44] text-gray-300 hover:border-violet-500 hover:text-violet-400"}`}>
                    ← Previous
                  </button>
                  <span className="text-xs text-gray-500">
                    {artistTotalPages ? `Page ${artistPage+1} of ${artistTotalPages} · ${artistTotal} songs` : `Page ${artistPage+1}`}
                  </span>
                  <button
                    onClick={()=>setArtistPage(p=>p+1)}
                    disabled={(artistTotalPages ? artistPage+1 >= artistTotalPages : !artistHasMore) || loading}
                    className={`text-xs px-4 py-2 rounded-lg border transition-all ${(artistTotalPages ? artistPage+1>=artistTotalPages : !artistHasMore)||loading?"border-[#1e1e2e] text-gray-700 cursor-not-allowed":"border-[#2e2e44] text-gray-300 hover:border-violet-500 hover:text-violet-400"}`}>
                    Next →
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ── Right: in queue ──────────────────────────────────────── */}
          <div className="md:flex-1 md:min-h-0 md:min-w-0 flex flex-col md:border-l md:border-[#1e1e2e] md:pl-6">
            <h2 className="text-sm font-semibold text-gray-300 mb-2 text-center md:text-left flex-shrink-0">
              📋 In Queue {folder.songs?.length ? `(${folder.songs.length})` : ""}
            </h2>
            <div className="md:flex-1 md:min-h-0 md:overflow-y-auto md:pr-1">
              {(!folder.songs || folder.songs.length === 0) ? (
                <p className="text-xs text-gray-600 text-center md:text-left py-4">No songs requested yet — be the first!</p>
              ) : (() => {
                // Pending shown in actual queue order now — that order is
                // exactly what votes reorder server-side, so this list is
                // "top of the real queue" reading top to bottom, not just a
                // recency list. Completed songs aren't vote-sorted, so most
                // recently finished first still reads fine there.
                const pending   = [...folder.songs].filter(s => !s.completed);
                const completed = [...folder.songs].filter(s => s.completed).reverse();
                const row = s => (
                  <div key={s.id}
                    className={`bg-[#15152280] border border-[#2a2a3e] rounded-lg px-3 py-2 text-xs flex items-center justify-between gap-2 ${s.completed ? "opacity-50" : ""}`}>
                    <div className="min-w-0">
                      <div className={`text-gray-200 font-medium truncate ${s.completed ? "line-through" : ""}`}>{s.completed ? "✓ " : ""}{s.title}</div>
                      <div className="text-gray-500 truncate">{s.artist || s.singer || "Unknown"}{(s.album || s.movie) ? ` · ${s.album || s.movie}` : ""}</div>
                    </div>
                    {!s.completed && (
                      <button onClick={()=>handleVote(s)} disabled={votingId===s.id}
                        title={votedIds.has(s.id) ? "Retract your vote" : "Vote this song up the queue"}
                        className={`flex items-center gap-1 px-2 py-1 rounded-lg border flex-shrink-0 transition-all disabled:opacity-50 ${votedIds.has(s.id) ? "border-pink-500/50 text-pink-400 bg-pink-500/10" : "border-[#2e2e44] text-gray-500 hover:border-pink-500/40 hover:text-pink-400"}`}>
                        <span>{votedIds.has(s.id) ? "❤️" : "🤍"}</span>
                        <span className="font-semibold">{s.votes || 0}</span>
                      </button>
                    )}
                  </div>
                );
                return (
                  <div className="space-y-1.5">
                    {pending.map(row)}
                    {completed.length > 0 && (
                      <>
                        <div className="text-xs text-gray-600 font-semibold uppercase tracking-wider pt-2 pb-1 border-t border-[#1a1a2a] mt-2">
                          ✓ Completed ({completed.length})
                        </div>
                        {completed.map(row)}
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ─── App Root ─────────────────────────────────────────────────────────
function App() {
  // ─── ALL HOOKS MUST BE DECLARED HERE, BEFORE ANY CONDITIONAL RETURNS ───
  const [user, setUser]                    = React.useState(null);
  const [bootLoading, setBootLoading]      = React.useState(true);
  const [view,setView]                     = React.useState("search");
  const [activeSong,setActiveSong]         = React.useState(null);
  const [activeFolderId,setActiveFolderId] = React.useState(null);
  const [sidebarCollapsed,setSidebarCollapsed] = React.useState(false);
  const [queueCollapsed,setQueueCollapsed] = React.useState(false);
  const [lyricsScale,setLyricsScale]       = React.useState(1);
  const [folders,setFolders]               = React.useState([]);
  const [shareTarget,setShareTarget]       = React.useState(null);
  const [showImport,setShowImport]         = React.useState(false);
  const [showSettings,setShowSettings]     = React.useState(false);
  const isMobile                           = useIsMobile();
  const [pendingShare,setPendingShare]     = React.useState(null);
  const [toast,showToast]                  = useToast();

  // ─── Broadcast state ──────────────────────────────────────────────
  // isBroadcasting: I'm the moderator pushing songs to a Realtime channel
  // broadcastModerator: someone ELSE is broadcasting in the folder I'm viewing
  // broadcastChannelRef: live Supabase Realtime channel for the current folder
  // followingBroadcast: I'm an audience member auto-switching when moderator does
  const [isBroadcasting, setIsBroadcasting] = React.useState(false);
  const [broadcastModerator, setBroadcastModerator] = React.useState(null);
  const [followingBroadcast, setFollowingBroadcast] = React.useState(false);
  const [viewerCount, setViewerCount] = React.useState(0);
  const [pendingBroadcastId, setPendingBroadcastId] = React.useState(null);
  const [subscribedRoom, setSubscribedRoom] = React.useState(null);
  const [lyricsRefreshTick, setLyricsRefreshTick] = React.useState(0);
  const broadcastChannelRef = React.useRef(null);

  // Restore session on first load
  React.useEffect(() => {
    (async () => {
      const sess = await db.restoreSession();
      if (sess) setUser(sess);
      setBootLoading(false);
    })();
  }, []);

  // Load folders from db whenever user changes; auto-create "Vibe List" if empty.
  // Skipped entirely for guest users — they only see the shared folder.
  React.useEffect(() => {
    if (!user)         { setFolders([]); return; }
    if (user.isGuest)  return; // guest folder is materialised by share-effect
    (async () => {
      let fs = await db.getFolders(user);
      if (!fs || fs.length === 0) {
        try {
          const def = await db.createFolder(user, "Vibe List");
          fs = [def];
        } catch (e) {
          console.warn("Could not auto-create default folder:", e?.message || e);
        }
      }
      setFolders(fs || []);
      const allSongs = (fs || []).flatMap(f => f.songs || []);
      if (allSongs.length) {
        archiveCustomSongs(allSongs);
        preFetchFolderSongs(allSongs).catch(() => {});
      }
    })();
  }, [user?.id]);

  // Detect ?share= URL on first load (now async — gzip decode)
  React.useEffect(() => {
    (async () => {
      const data = await decodeShareFromUrl();
      if (data) setPendingShare(data);
    })();
  }, []);

  // When a share link is opened by a signed-in user → prompt them to import.
  // When opened by a guest (no account) → drop them STRAIGHT into a preview
  // of the folder, no auth wall. They can sign up later to save it.
  React.useEffect(() => {
    if (!pendingShare) return;
    if (user && !user.isGuest) {
      setShowImport(true);
      return;
    }
    if (!user) {
      // Create an in-memory guest session — no Supabase writes, no persistence
      const guest = {
        id:        "guest_" + Math.random().toString(36).slice(2,10),
        username:  pendingShare.ownerName ? `Guest of ${pendingShare.ownerName}` : "Guest",
        color:     "#6b7280",
        isGuest:   true,
      };
      setUser(guest);
    }
  }, [user, pendingShare]);

  // After guest user is set + we have a pending share, materialise the folder
  // locally so the existing FolderView/LiveSongView can render it as-is.
  React.useEffect(() => {
    if (!user?.isGuest || !pendingShare) return;
    if (folders.some(f => f.broadcastRoom === pendingShare.broadcastRoom)) return;
    const songs = (pendingShare.songs || []).map(s => ({ ...s, type: s.type || "live" }));
    songs.forEach(cacheSong);
    if (pendingShare.lyricsCache) {
      for (const [songId, data] of Object.entries(pendingShare.lyricsCache)) {
        if (data?.lyrics) setCachedLyrics(songId, data);
      }
    }
    const guestFolder = {
      id:                 "guest_folder_" + (pendingShare.broadcastRoom || newFolderId()),
      name:               pendingShare.folderName || "Shared folder",
      songs,
      shareCode:          null,
      broadcastRoom:      pendingShare.broadcastRoom || null,
      originalOwnerId:    pendingShare.ownerId || null,
      originalOwnerName:  pendingShare.ownerName || null,
    };
    setFolders([guestFolder]);
    setActiveFolderId(guestFolder.id);
    setView("folder");
    archiveCustomSongs(songs);
    fillLyricsFromArchive(songs).then(() => preFetchFolderSongs(songs)).catch(() => {});
  }, [user, pendingShare]);

  const logout = async () => {
    // Guest → flip to the auth page (preserving pendingShare so they can
    // sign up and import this folder permanently).
    if (user?.isGuest) {
      setUser(null); setFolders([]); setView("search");
      setActiveSong(null); setActiveFolderId(null); setSidebarCollapsed(false);
      return;
    }
    await db.signOut();
    setUser(null); setFolders([]); setView("search");
    setActiveSong(null); setActiveFolderId(null); setSidebarCollapsed(false);
    setPendingShare(null);
    clearShareFromUrl();
  };

  const createFolder = async (name) => {
    const newF = await db.createFolder(user, name);
    setFolders(f => [...f, newF]);
    return newF;
  };

  const deleteFolder = async (id) => {
    setFolders(f => f.filter(x => x.id !== id));
    if (activeFolderId === id) { setView("search"); setActiveFolderId(null); }
    await db.deleteFolder(user, id);
  };

  const renameFolder = async (id, name) => {
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    setFolders(f => f.map(x => x.id === id ? { ...x, name: trimmed } : x));
    const folder = folders.find(x => x.id === id);
    if (!folder) return;
    // Rename doesn't intend to touch songs at all, but every write here
    // still replaces the whole row — go through the fresh-songs path (an
    // identity mutate) so it can't accidentally clobber a concurrent add.
    const updated = await db.mutateFolderSongs(user, { ...folder, name: trimmed }, songs => songs);
    setFolders(f => f.map(x => x.id === id ? updated : x));
  };

  // Pulls this one folder's current songs from the DB and merges them into
  // local state in place — lets someone pick up a song added via a Request
  // Songs link (or from another device) without reloading the whole app
  // and losing their scroll position / getting bounced back to the home screen.
  const refreshFolder = async (fid) => {
    const songs = await db.getFolderSongs(user, fid);
    if (!songs) { showToast("Couldn't refresh — try again"); return; }
    setFolders(f => f.map(x => x.id === fid ? { ...x, songs } : x));
    setActiveSong(prev => {
      if (!prev) return prev;
      const fresh = songs.find(s => s.id === prev.id);
      return fresh ? { ...prev, ...fresh } : prev;
    });
    showToast("Queue refreshed");
  };

  // Randomizes the order of pending songs and moves completed ones to the
  // end, so the numbers that remain always read 1..N with no gaps left by
  // completed songs — e.g. 10 songs, #8 completed, shuffle → 9 songs, 1-9.
  const shuffleQueueNumbers = async (fid) => {
    const folder = folders.find(f => f.id === fid);
    if (!folder) return;
    const doShuffle = songs => {
      const pending   = songs.filter(s => !s.completed);
      const completed = songs.filter(s => s.completed);
      for (let i = pending.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pending[i], pending[j]] = [pending[j], pending[i]];
      }
      return [...pending, ...completed];
    };
    // Optimistic local shuffle for instant feedback...
    setFolders(f => f.map(x => x.id === fid ? { ...x, songs: doShuffle(x.songs) } : x));
    // ...then persist against the freshest server state and reconcile —
    // covers any song added by someone else in the meantime too.
    const updated = await db.mutateFolderSongs(user, folder, doShuffle);
    setFolders(f => f.map(x => x.id === fid ? updated : x));
  };

  const addToFolder = async (fid, song) => {
    cacheSong(song);
    const folder = folders.find(f => f.id === fid);
    if (!folder) return;
    if (!folder.songs.some(s => s.id === song.id)) {
      setFolders(f => f.map(x => x.id === fid ? { ...x, songs: [...x.songs, song] } : x));
    }
    preFetchLyrics(song);
    showToast(`Added "${song.title}" to folder`);
    const updated = await db.mutateFolderSongs(user, folder, songs =>
      songs.some(s => s.id === song.id) ? songs : [...songs, song]
    );
    setFolders(f => f.map(x => x.id === fid ? updated : x));
  };

  const removeFromFolder = async (fid, sid) => {
    const folder = folders.find(f => f.id === fid);
    if (!folder) return;
    setFolders(f => f.map(x => x.id === fid ? { ...x, songs: x.songs.filter(s => s.id !== sid) } : x));
    const updated = await db.mutateFolderSongs(user, folder, songs => songs.filter(s => s.id !== sid));
    setFolders(f => f.map(x => x.id === fid ? updated : x));
  };

  const toggleSongCompleted = async (fid, sid) => {
    const folder = folders.find(f => f.id === fid);
    if (!folder) return;
    const flip = songs => songs.map(s => s.id === sid ? { ...s, completed: !s.completed } : s);
    setFolders(f => f.map(x => x.id === fid ? { ...x, songs: flip(x.songs) } : x));
    // Keep the currently-open song's own completed flag in sync too — it's a
    // separate piece of state from `folders`, so a toggle button on the song
    // view itself would otherwise show stale state until you navigate away.
    setActiveSong(prev => prev && prev.id === sid ? { ...prev, completed: !prev.completed } : prev);
    const updated = await db.mutateFolderSongs(user, folder, flip);
    setFolders(f => f.map(x => x.id === fid ? updated : x));
  };

  // Persist a folder's audience-request token once (created lazily by
  // RequestLinkModal) so the request link is stable across opens.
  const persistRequestToken = async (fid, token) => {
    const target = folders.find(f => f.id === fid);
    if (!target) return;
    setFolders(f => f.map(x => x.id === fid ? { ...x, requestToken: token } : x));
    try {
      const updated = await db.mutateFolderSongs(user, { ...target, requestToken: token }, songs => songs);
      setFolders(f => f.map(x => x.id === fid ? updated : x));
    } catch {}
  };

  const selectFolder = id => { setActiveFolderId(id); setView("folder"); };

  // ─── Custom-lyrics state ──────────────────────────────────────────
  // editorState: { mode: "new"|"edit", folderId, song? }
  const [editorState, setEditorState] = React.useState(null);

  const openAddCustom = (folderId) => {
    // folderId may be null when invoked from home page → modal will show picker
    setEditorState({ mode: "new", folderId });
  };
  // Edit handler — prefills BOTH the native and roman textareas so the user
  // doesn't have to start from scratch in either script.
  const openEditSong = (folderId, song, providedLyrics) => {
    const cached = getCachedLyrics(song.id);
    // Native-script source candidates, in priority order
    let nativeFill = song.customLyrics || "";
    if (!nativeFill && providedLyrics && detectScript(providedLyrics)) nativeFill = providedLyrics;
    if (!nativeFill && cached?.lyrics && detectScript(cached.lyrics))   nativeFill = cached.lyrics;

    // Romanised source candidates
    let romanFill = song.customLyricsRoman || "";
    if (!romanFill && providedLyrics && !detectScript(providedLyrics))  romanFill = providedLyrics;
    if (!romanFill && cached?.googleRoman)                              romanFill = cached.googleRoman;

    setEditorState({
      mode: "edit",
      folderId,
      song: { ...song, customLyrics: nativeFill, customLyricsRoman: romanFill },
    });
  };

  // Save handler — covers both new-custom and edit-existing
  const saveLyricsEdit = async (data) => {
    if (!editorState) return;
    const { mode, song } = editorState;
    // Resolve folder: explicit prop, or fall back to picker selection from modal
    const folderId = editorState.folderId || data.folderId;
    const folder = folders.find(f => f.id === folderId);
    if (!folder) { setEditorState(null); return; }

    // Common patch object the modal produced
    const patch = {
      title: data.title, artist: data.artist, album: data.album,
      language: data.language,
      customLyrics:      data.customLyrics,
      customLyricsRoman: data.customLyricsRoman,
    };

    const existingIndex = song ? folder.songs.findIndex(s => s.id === song.id) : -1;
    const newCustomId = "cs_" + (window.crypto?.randomUUID?.() || (Date.now()+"-"+Math.random().toString(36).slice(2,8)));
    // Decided against whatever song list it's applied to (fresh from the DB
    // at persist time, not necessarily this device's local `folder.songs`)
    // so a concurrent add from someone else can't get clobbered by this save.
    const mutate = songs => {
      const idx = song ? songs.findIndex(s => s.id === song.id) : -1;
      if (mode === "edit" && idx >= 0) {
        return songs.map(s => s.id === song.id ? { ...s, ...patch } : s);
      }
      const baseSong = song && mode === "edit"
        ? { ...song, ...patch }   // editing a song from search — keep its iTunes id/cover
        : { id: newCustomId, type: "custom", ...patch };
      return [...songs, baseSong];
    };

    // Optimistic local update for instant feedback, using this device's own
    // view of the folder (existingIndex) just to decide the toast wording.
    let updated = { ...folder, songs: mutate(folder.songs) };
    setFolders(f => f.map(x => x.id === folderId ? updated : x));
    if (mode === "edit" && existingIndex >= 0) {
      if (activeSong && activeSong.id === song.id) setActiveSong({ ...activeSong, ...patch });
      showToast(`Lyrics saved`);
    } else {
      if (activeSong && song && activeSong.id === song.id) setActiveSong({ ...activeSong, ...patch });
      showToast(`Saved "${data.title}" to ${folder.name}`);
    }

    updated = await db.mutateFolderSongs(user, folder, mutate);
    setFolders(f => f.map(x => x.id === folderId ? updated : x));

    archiveSong(
      { title: data.title, artist: data.artist, album: data.album },
      { native: data.customLyrics, roman: data.customLyricsRoman, source: "custom" }
    );

    // If I'm broadcasting on this folder, push the lyrics edit to followers
    if (isBroadcasting && broadcastChannelRef.current && activeFolderId === folderId) {
      const targetId = (mode === "edit" && song) ? song.id : updated.songs[updated.songs.length - 1].id;
      broadcastChannelRef.current.send({
        type: "broadcast",
        event: "lyrics_update",
        payload: { songId: targetId, patch },
      });
    }

    setEditorState(null);
  };

  const importFolder = async (entry) => {
    const songs = (entry.songs || []).map(s => ({ ...s, type: s.type || "live" }));
    songs.forEach(cacheSong);

    // If the share link included embedded lyrics, write them straight into the
    // local lyrics cache so songs open instantly with zero fetch needed.
    if (entry.lyricsCache && typeof entry.lyricsCache === "object") {
      for (const [songId, data] of Object.entries(entry.lyricsCache)) {
        if (data && data.lyrics) setCachedLyrics(songId, data);
      }
    }

    // For anything the sharer hadn't cached (so couldn't embed above), try
    // our own song_archive next — still much faster than a live fetch, and
    // means the shared folder doesn't depend on the sharer's device state.
    await fillLyricsFromArchive(songs);

    const newF = await db.createFolder(user, `${entry.folderName} (${entry.ownerName})`);
    newF.songs = songs;
    // Carry the broadcast room + original owner forward so audience can follow
    if (entry.broadcastRoom) newF.broadcastRoom    = entry.broadcastRoom;
    if (entry.ownerId)       newF.originalOwnerId  = entry.ownerId;
    if (entry.ownerName)     newF.originalOwnerName = entry.ownerName;
    await db.updateFolder(user, newF);
    setFolders(f => [...f, newF]);
    setPendingShare(null);
    clearShareFromUrl();

    const readyCount = songs.filter(s => s.type !== "live" || s.customLyrics || getCachedLyrics(s.id)).length;
    if (readyCount) {
      showToast(`Imported ${songs.length} songs — ${readyCount} ready instantly`);
    } else {
      showToast(`Imported ${songs.length} songs`);
    }
    // Pre-fetch anything still missing (not embedded, not archived) in background
    archiveCustomSongs(songs);
    preFetchFolderSongs(songs).catch(() => {});
  };

  const openSong = (song, folderId) => {
    cacheSong(song);
    setActiveSong(song);
    const resolved = folderId !== undefined
      ? folderId
      : (folders.find(f => f.songs.some(s => s.id === song.id))?.id ?? null);
    setActiveFolderId(resolved);
    setView("song");
    setSidebarCollapsed(true);

    // If I'm broadcasting, push this song (+ cached lyrics) to the audience
    if (isBroadcasting && broadcastChannelRef.current) {
      const cachedLyrics = getCachedLyrics(song.id) || undefined;
      broadcastChannelRef.current.send({
        type: "broadcast",
        event: "song_change",
        payload: { song, cachedLyrics, broadcaster: user?.username },
      });
    }
  };

  const activeFolder = folders.find(f => f.id === activeFolderId);
  const folderSongs  = activeFolder ? activeFolder.songs : [];

  // ─── Broadcast helpers ────────────────────────────────────────────
  // Am I allowed to broadcast on this folder? Only the original owner can.
  const canBroadcast = !!activeFolder && (
    !activeFolder.originalOwnerId || activeFolder.originalOwnerId === user?.id
  );

  // Subscribe to the broadcast channel for the active folder
  React.useEffect(() => {
    if (!activeFolder?.broadcastRoom || !HAS_SUPABASE) return;
    const channel = sb.channel(`jambook-bc:${activeFolder.broadcastRoom}`, {
      config: { broadcast: { self: false }, presence: { key: user?.id || "anon" } },
    });
    broadcastChannelRef.current = channel;
    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        const count = Object.values(state).reduce((s, arr) => s + arr.length, 0);
        setViewerCount(count);
      })
      .on("broadcast", { event: "moderator_start" }, ({ payload }) => {
        setBroadcastModerator(payload || { name: "Someone" });
      })
      .on("broadcast", { event: "moderator_stop" }, () => {
        setBroadcastModerator(null);
        setFollowingBroadcast(false);
      })
      .on("broadcast", { event: "song_change" }, ({ payload }) => {
        // Audience receives: cache lyrics if provided, then open the song
        if (!payload?.song) return;
        if (payload.cachedLyrics) {
          try { setCachedLyrics(payload.song.id, payload.cachedLyrics); } catch {}
        }
        if (!isBroadcastingRef.current) {
          // Switch to following mode automatically
          setFollowingBroadcast(true);
          cacheSong(payload.song);
          setActiveSong(payload.song);
          setView("song");
        }
      })
      .on("broadcast", { event: "source_change" }, ({ payload }) => {
        // Moderator switched lyrics source — write the fresh blob into cache and
        // bump the refresh tick so LiveSongView re-reads. Ignore if I'm broadcasting.
        if (!payload?.songId || !payload?.lyricsData || isBroadcastingRef.current) return;
        try { setCachedLyrics(payload.songId, payload.lyricsData); } catch {}
        setLyricsRefreshTick(t => t + 1);
      })
      .on("broadcast", { event: "lyrics_update" }, ({ payload }) => {
        // Moderator edited a song's lyrics — patch any folder containing it + activeSong, refresh cache
        if (!payload?.songId || !payload?.patch || isBroadcastingRef.current) return;
        const { songId, patch } = payload;
        setFolders(fs => fs.map(f => ({
          ...f,
          songs: (f.songs || []).map(s => s.id === songId ? { ...s, ...patch } : s),
        })));
        setActiveSong(prev => prev && prev.id === songId ? { ...prev, ...patch } : prev);
        // Invalidate stale lyrics cache so LiveSongView re-reads customLyrics from song
        try {
          const existing = getCachedLyrics(songId);
          if (existing) setCachedLyrics(songId, { ...existing, lyrics: patch.customLyrics || existing.lyrics, googleRoman: null });
        } catch {}
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ username: user?.username || "viewer" });
          setSubscribedRoom(activeFolder.broadcastRoom);
        }
      });
    return () => {
      try { sb.removeChannel(channel); } catch {}
      broadcastChannelRef.current = null;
      setBroadcastModerator(null);
      setFollowingBroadcast(false);
      setViewerCount(0);
      setSubscribedRoom(null);
    };
  }, [activeFolder?.broadcastRoom]);

  // Ref-mirror of isBroadcasting so the channel callback closures see latest
  const isBroadcastingRef = React.useRef(false);
  React.useEffect(() => { isBroadcastingRef.current = isBroadcasting; }, [isBroadcasting]);

  // Start broadcasting (moderator only) — assigns a broadcastRoom if missing
  const startBroadcast = async () => {
    if (!activeFolder || !canBroadcast) return;
    let folder = activeFolder;
    if (!folder.broadcastRoom) {
      const room = newBroadcastRoom();
      setFolders(fs => fs.map(x => x.id === folder.id ? { ...x, broadcastRoom: room } : x));
      let updated = { ...folder, broadcastRoom: room };
      try { updated = await db.mutateFolderSongs(user, updated, songs => songs); } catch {}
      setFolders(fs => fs.map(x => x.id === folder.id ? updated : x));
      folder = updated;
      // Trigger re-subscribe by waiting one tick (effect will pick up new room)
      await new Promise(r => setTimeout(r, 50));
    }
    setIsBroadcasting(true);
    const channel = broadcastChannelRef.current;
    if (channel) {
      channel.send({ type: "broadcast", event: "moderator_start", payload: { name: user.username } });
    }
    showToast("Broadcasting started · your song picks will sync");
  };

  const stopBroadcast = async () => {
    setIsBroadcasting(false);
    const channel = broadcastChannelRef.current;
    if (channel) {
      channel.send({ type: "broadcast", event: "moderator_stop", payload: {} });
    }
    showToast("Broadcast stopped");
  };

  const leaveBroadcast = () => {
    setFollowingBroadcast(false);
  };

  // Pushed by LiveSongView's switchSource() when the moderator picks a different
  // lyrics source — sends the freshly-fetched lyrics blob to every follower.
  const broadcastSourceChange = React.useCallback((songId, lyricsData) => {
    if (!isBroadcasting || !broadcastChannelRef.current) return;
    broadcastChannelRef.current.send({
      type: "broadcast",
      event: "source_change",
      payload: { songId, lyricsData },
    });
  }, [isBroadcasting]);

  // One-click start from the home-page folder menu: navigate + start once channel is ready
  const requestStartBroadcast = (folderId) => {
    setActiveFolderId(folderId);
    setView("folder");
    setSidebarCollapsed(false);
    setPendingBroadcastId(folderId);
  };

  // Finalise a pending broadcast start once channel subscribes for the target folder
  React.useEffect(() => {
    if (!pendingBroadcastId) return;
    if (activeFolderId !== pendingBroadcastId) return;
    if (!activeFolder || !canBroadcast) return;
    if (isBroadcasting) { setPendingBroadcastId(null); return; }
    if (!activeFolder.broadcastRoom) {
      const room = newBroadcastRoom();
      setFolders(fs => fs.map(x => x.id === activeFolder.id ? { ...x, broadcastRoom: room } : x));
      db.mutateFolderSongs(user, { ...activeFolder, broadcastRoom: room }, songs => songs)
        .then(updated => setFolders(fs => fs.map(x => x.id === activeFolder.id ? updated : x)))
        .catch(()=>{});
      return; // wait for re-subscribe with new room
    }
    if (subscribedRoom !== activeFolder.broadcastRoom) return; // channel not ready yet
    setIsBroadcasting(true);
    broadcastChannelRef.current?.send({
      type: "broadcast", event: "moderator_start", payload: { name: user.username },
    });
    showToast("Broadcasting started · your song picks will sync");
    setPendingBroadcastId(null);
  }, [pendingBroadcastId, activeFolderId, activeFolder?.broadcastRoom, subscribedRoom, canBroadcast, isBroadcasting]);

  // Boot splash while restoring session
  if (bootLoading) {
    return (
      <div className="auth-bg min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin"/>
      </div>
    );
  }

  if (!user) return <AuthPage onLogin={setUser}/>;

  // Sidebar is hidden on the home/search view, and entirely on mobile
  const showSidebar = view !== "search" && !isMobile;

  return (
    <div className="flex h-screen overflow-hidden">
      {showSidebar && (
        <Sidebar
          user={user} folders={folders} activeFolderId={activeFolderId}
          onSelectFolder={selectFolder} onCreateFolder={createFolder} onDeleteFolder={deleteFolder} onRenameFolder={renameFolder}
          onShareFolder={setShareTarget} onShowImport={()=>setShowImport(true)}
          activeView={view} onGoSearch={()=>{setView("search");setActiveFolderId(null);}}
          collapsed={sidebarCollapsed} onToggleCollapse={()=>setSidebarCollapsed(v=>!v)}
          onLogout={logout}
        />
      )}
      <main className="flex-1 overflow-hidden flex flex-col min-w-0">
        {view==="search"&&(
          <SearchPage onOpenSong={openSong} folders={folders} onAddToFolder={addToFolder} user={user} onSelectFolder={selectFolder} onCreateFolder={createFolder} onShareFolder={setShareTarget} onLogout={logout} onAddCustomLyrics={()=>openAddCustom(null)} onOpenSettings={()=>setShowSettings(true)} onDeleteFolder={deleteFolder} onRenameFolder={renameFolder} onStartBroadcast={requestStartBroadcast}/>
        )}
        {view==="song"&&activeSong&&activeSong.type==="curated"&&(
          <CuratedSongView
            song={activeSong} onBack={()=>setView("search")} folders={folders} onAddToFolder={addToFolder}
            activeFolder={activeFolder} folderSongs={folderSongs} onOpenSong={s=>openSong(s,activeFolderId)}
            onToggleCompleted={toggleSongCompleted}
            lyricsScale={lyricsScale} onLyricsScaleChange={setLyricsScale}
            queueCollapsed={queueCollapsed} onToggleQueueCollapse={()=>setQueueCollapsed(v=>!v)}
            onShuffleQueue={shuffleQueueNumbers}
            onRefreshQueue={refreshFolder}
          />
        )}
        {view==="song"&&activeSong&&activeSong.type!=="curated"&&(
          <LiveSongView
            song={activeSong} onBack={()=>{ user?.isGuest&&activeFolderId ? setView("folder") : setView("search"); }} folders={folders} onAddToFolder={addToFolder}
            activeFolder={activeFolder} folderSongs={folderSongs}
            onOpenSong={s=>openSong(s,activeFolderId)}
            onEditSong={(s, currentLyrics)=>openEditSong(activeFolderId, s, currentLyrics)}
            onShareFolder={setShareTarget}
            onToggleCompleted={toggleSongCompleted}
            isBroadcasting={isBroadcasting}
            broadcastModerator={broadcastModerator}
            followingBroadcast={followingBroadcast}
            onLeaveBroadcast={leaveBroadcast}
            canBroadcast={canBroadcast}
            onStartBroadcast={startBroadcast}
            onStopBroadcast={stopBroadcast}
            viewerCount={viewerCount}
            onBroadcastSourceChange={broadcastSourceChange}
            lyricsRefreshTick={lyricsRefreshTick}
            lyricsScale={lyricsScale} onLyricsScaleChange={setLyricsScale}
            queueCollapsed={queueCollapsed} onToggleQueueCollapse={()=>setQueueCollapsed(v=>!v)}
            onShuffleQueue={shuffleQueueNumbers}
            onRefreshQueue={refreshFolder}
          />
        )}
        {view==="folder"&&activeFolder&&(
          <FolderView
            folder={activeFolder} songs={folderSongs}
            onOpenSong={s=>openSong(s,activeFolder.id)}
            onRemove={removeFromFolder}
            onRefresh={()=>refreshFolder(activeFolder.id)}
            onBack={()=>{
              if (user?.isGuest) { logout(); return; }
              setView("search"); setActiveFolderId(null);
            }}
            onAddCustom={()=>openAddCustom(activeFolder.id)}
            onEditSong={(s)=>openEditSong(activeFolder.id, s)}
            canBroadcast={canBroadcast}
            isBroadcasting={isBroadcasting}
            onStartBroadcast={startBroadcast}
            onStopBroadcast={stopBroadcast}
            broadcastModerator={broadcastModerator}
            followingBroadcast={followingBroadcast}
            onLeaveBroadcast={leaveBroadcast}
            viewerCount={viewerCount}
            showToast={showToast}
            onPersistRequestToken={persistRequestToken}
          />
        )}
      </main>

      {editorState && (
        <LyricsEditorModal
          mode={editorState.mode}
          initialSong={editorState.song || null}
          onSave={saveLyricsEdit}
          onClose={()=>setEditorState(null)}
          folders={folders}
          needsFolderPick={!editorState.folderId}
        />
      )}

      {shareTarget && (
        <ShareModal
          folder={shareTarget}
          user={user}
          folderSongs={shareTarget.songs || []}
          onClose={()=>setShareTarget(null)}
          showToast={showToast}
          onPersistRoom={async (folderId, room) => {
            // Save the newly-generated broadcastRoom back to the folder
            const target = folders.find(f => f.id === folderId);
            if (!target) return;
            setFolders(f => f.map(x => x.id === folderId ? { ...x, broadcastRoom: room } : x));
            try {
              const updated = await db.mutateFolderSongs(user, { ...target, broadcastRoom: room }, songs => songs);
              setFolders(f => f.map(x => x.id === folderId ? updated : x));
            } catch {}
          }}
          onShareCodePersisted={(folderId, code) => {
            setShareTarget(prev => prev?.id === folderId ? { ...prev, shareCode: code } : prev);
            setFolders(fs => fs.map(x => x.id === folderId ? { ...x, shareCode: code } : x));
          }}
        />
      )}
      {showImport && (
        <ImportModal
          user={user}
          preloadedData={pendingShare}
          onImport={importFolder}
          onClose={()=>{ setShowImport(false); if(pendingShare){ setPendingShare(null); clearShareFromUrl(); } }}
          showToast={showToast}
        />
      )}
      {showSettings && (
        <SettingsModal onClose={()=>setShowSettings(false)} showToast={showToast}/>
      )}
      {toast&&<div className="toast">{toast}</div>}
    </div>
  );
}

// ─── Error boundary — shows the actual error instead of a blank screen ───
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("[JamBook crash]", error, info); }
  render() {
    if (this.state.error) {
      const msg = this.state.error?.message || String(this.state.error);
      return (
        <div style={{padding:24, fontFamily:"Inter, sans-serif", color:"#e8e8f0", background:"#0f0f14", minHeight:"100vh"}}>
          <h2 style={{color:"#f87171", fontSize:18, marginBottom:8}}>⚠ App crashed</h2>
          <pre style={{whiteSpace:"pre-wrap", fontSize:12, color:"#d4d4d8", background:"#1a1a2e", padding:12, borderRadius:8, overflow:"auto"}}>{msg}</pre>
          <p style={{fontSize:12, color:"#71717a", marginTop:12}}>Open the console (F12) to see the full stack trace. Share the error above with the developer.</p>
          <button onClick={()=>{ this.setState({error:null}); window.location.reload(); }}
            style={{marginTop:16, padding:"8px 16px", background:"#7c3aed", color:"white", border:"none", borderRadius:8, cursor:"pointer", fontSize:13}}>
            ↺ Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ?request=<token> bypasses the whole app (no login, no sidebar) — just the
// audience song-request page. Checked once at mount, not inside App's state,
// so a broken/expired token can never fall through into the authenticated UI.
const requestToken = new URLSearchParams(window.location.search).get("request");

ReactDOM.createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    {requestToken ? <RequestSongPage token={requestToken}/> : <App/>}
  </ErrorBoundary>
);
