import React from "react";
import ReactDOM from "react-dom/client";


// ─── Curated songs (placeholder lines — not real copyrighted lyrics) ──
const CURATED = [];

const TAG_CONFIG    = {male:{label:"Male",class:"tag-male"},female:{label:"Female",class:"tag-female"},chorus:{label:"Chorus",class:"tag-chorus"},duet:{label:"Duet",class:"tag-duet"},humming:{label:"Humming",class:"tag-humming"}};
const LANGUAGES     = ["All","Tamil","Hindi","Telugu","Malayalam","Kannada","English"];
const SCROLL_SPEEDS = [{label:"Slow",key:"slow",px:18},{label:"Medium",key:"medium",px:45},{label:"Fast",key:"fast",px:90}];
const LANG_COLORS   = {Tamil:"bg-orange-900/30 text-orange-400",Hindi:"bg-blue-900/30 text-blue-400",Telugu:"bg-green-900/30 text-green-400",Malayalam:"bg-pink-900/30 text-pink-400",Kannada:"bg-yellow-900/30 text-yellow-400",English:"bg-teal-900/30 text-teal-400"};
const AVATAR_COLORS = ["#7c3aed","#0891b2","#059669","#d97706","#db2777","#dc2626","#4f46e5","#0d9488"];

// ─── Supabase backend (cross-device sync) ─────────────────────────────
// Paste your project URL + anon key from Supabase → Settings → API.
// If left blank the app falls back to localStorage (single-device).
const SUPABASE_URL = "";
const SUPABASE_KEY = "";

const sb = (SUPABASE_URL && SUPABASE_KEY && window.supabase)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;
const HAS_SUPABASE = !!sb;

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

async function searchSongs(query) {
  // Fetch from multiple stores in parallel for max coverage
  const batches = await Promise.all(ITUNES_STORES.map(c => searchOneStore(query, c)));
  const all     = batches.flat();

  // Dedupe by trackId — iTunes often returns the same song across stores
  const seen = new Set();
  const out  = [];
  for (const s of all) {
    if (!s.trackId || seen.has(s.trackId)) continue;
    seen.add(s.trackId);
    out.push({
      id:       `it_${s.trackId}`,
      type:     "live",
      itunesId: s.trackId,
      title:    s.trackName,
      artist:   s.artistName,
      album:    s.collectionName,
      cover:    s.artworkUrl100,
      preview:  s.previewUrl,
      language: "Unknown",
    });
  }
  console.log(`[JamBook] iTunes search "${query}": ${all.length} raw → ${out.length} unique songs`);
  return out;
}

// ── Strip noise from titles for better API matching ───────────────────
function normalizeTitle(t) {
  return t
    .replace(/\(feat\..*?\)/gi,'').replace(/\[feat\..*?\]/gi,'')
    .replace(/\bft\..*$/gi,'').replace(/\(from\b.*?\)/gi,'')
    .replace(/\(.*?version\)/gi,'').replace(/\(.*?remix\)/gi,'')
    .trim();
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
    .replace(/\bnga/g, "nga")
    .replace(/(\w)\1{2,}/g, "$1$1");    // collapse triple consonants

  return out;
}

// ── Local (instant) fallback: rule-based transliteration ─────────────
function transliterateLocal(text) {
  const script = detectScript(text);
  if (!script) return text;
  if (script === "tamil") return tamilToTanglish(text);
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
    return out.join("\n");
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
function parseStructured(lyrics) {
  const rawStanzas = lyrics.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);

  // First pass: parse each stanza's content + explicit markers
  const parsed = rawStanzas.map(stanza => {
    const rawLines = stanza.split("\n");
    let explicitSection = null;
    const lines = [];
    for (const raw of rawLines) {
      const sec = matchSection(raw);
      if (sec) { explicitSection = sec; continue; }
      if (!raw.trim()) { lines.push({ kind: "blank" }); continue; }
      if (isChordLine(raw)) { lines.push({ kind: "chord", text: raw.trim() }); continue; }
      lines.push({ kind: "lyric", text: raw });
    }
    // Normalised body — for repeat detection (lowercased, lyric lines only)
    const bodyKey = lines.filter(l => l.kind === "lyric").map(l => l.text.toLowerCase().trim().replace(/[.,!?;:'"]/g,"")).join("|");
    return { explicitSection, lines, bodyKey };
  });

  // Second pass: count occurrences of each bodyKey
  const counts = {};
  for (const p of parsed) if (p.bodyKey) counts[p.bodyKey] = (counts[p.bodyKey] || 0) + 1;

  // Third pass: assign sections
  let verseNum = 0;
  return parsed.map(p => {
    let section = p.explicitSection;
    if (!section) {
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
const LYRIC_SOURCES = ["tamil2lyrics","lrclib","lyrics.ovh","some-random-api","ChartLyrics"];

// CORS proxy for sites that block direct browser access
const CORS_PROXY = "https://api.allorigins.win/raw?url=";

// 0. tamil2lyrics.com — human-curated Tanglish lyrics for Tamil songs.
// Scrapes search results page, then the song page, extracting English/Tanglish text.
async function fetchFromTamil2Lyrics(artist, title) {
  // Search the site
  const searchUrl = `https://www.tamil2lyrics.com/?s=${encodeURIComponent(title + ' ' + (artist || ''))}`;
  const sr = await fetch(CORS_PROXY + encodeURIComponent(searchUrl));
  if (!sr.ok) throw new Error("search fail");
  const searchHtml = await sr.text();

  // First lyrics page link from results
  const linkMatch = searchHtml.match(/href="(https?:\/\/(?:www\.)?tamil2lyrics\.com\/lyrics\/[^"#?]+)"/i);
  if (!linkMatch) throw new Error("not found");

  // Fetch song page
  const pr = await fetch(CORS_PROXY + encodeURIComponent(linkMatch[1]));
  if (!pr.ok) throw new Error("page fail");
  const pageHtml = await pr.text();

  // Extract the main article body
  const bodyMatch = pageHtml.match(/<div[^>]*class="[^"]*(?:entry-content|post-content|td-post-content)[^"]*"[^>]*>([\s\S]*?)(?:<\/article|<footer|<div[^>]*class="[^"]*(?:sharedaddy|related|comments|widget))/i);
  if (!bodyMatch) throw new Error("parse fail");
  const body = bodyMatch[1];

  // tamil2lyrics typically has Tamil section followed by an English/Tanglish section.
  // Try to grab the English/Tanglish part specifically.
  const engSplit = body.split(/<h[1-6][^>]*>[^<]*(?:English|Tanglish|Romanized|Translation)[^<]*<\/h[1-6]>/i);
  const block = engSplit.length > 1 ? engSplit[engSplit.length - 1] : body;

  // Strip HTML to plain text
  let text = block
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Sanity: ensure most letters look Latin (Tanglish), not Tamil-script
  const tamilChars  = (text.match(/[஀-௿]/g) || []).length;
  const latinChars  = (text.match(/[a-zA-Z]/g) || []).length;
  if (latinChars < 80 || tamilChars > latinChars) throw new Error("not tanglish");
  if (text.length < 100) throw new Error("empty");

  return { lyrics: text, source: "tamil2lyrics", alreadyRomanized: true };
}

// 1. lrclib.net — free, no key, CORS, strong Indian + global coverage
async function fetchFromLrclib(artist, title) {
  const r1 = await fetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&album_name=`);
  if (r1.ok) {
    const d = await r1.json();
    const lyr = d.plainLyrics || (d.syncedLyrics ? d.syncedLyrics.replace(/^\[[\d:\.]+\]\s*/gm,'') : null);
    if (lyr && lyr.length > 30) return { lyrics: lyr, source: "lrclib" };
  }
  const r2 = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(title+' '+artist)}`);
  if (!r2.ok) throw new Error("not found");
  const hits = await r2.json();
  const hit  = hits.find(h => h.plainLyrics);
  if (!hit) throw new Error("empty");
  return { lyrics: hit.plainLyrics, source: "lrclib" };
}

// 2. lyrics.ovh — free, no key, CORS
async function fetchFromOvh(artist, title) {
  const r = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
  if (!r.ok) throw new Error("not found");
  const d = await r.json();
  if (!d.lyrics || d.lyrics.length < 30) throw new Error("empty");
  return { lyrics: d.lyrics, source: "lyrics.ovh" };
}

// 3. some-random-api.com — free, no key, broad coverage
async function fetchFromSRA(artist, title) {
  const r = await fetch(`https://some-random-api.com/lyrics?title=${encodeURIComponent(title+' '+artist)}`);
  if (!r.ok) throw new Error("not found");
  const d = await r.json();
  if (!d.lyrics || d.lyrics.length < 30) throw new Error("empty");
  return { lyrics: d.lyrics, source: "some-random-api" };
}

// 4. ChartLyrics — free, no key
async function fetchFromChartLyrics(artist, title) {
  const r = await fetch(`https://api.chartlyrics.com/apiv1.asmx/SearchLyricDirect?artist=${encodeURIComponent(artist)}&song=${encodeURIComponent(title)}`);
  if (!r.ok) throw new Error("not found");
  const text = await r.text();
  const m = text.match(/<Lyric>([\s\S]*?)<\/Lyric>/);
  const l = m ? m[1].trim() : null;
  if (!l || l.length < 30) throw new Error("empty");
  return { lyrics: l, source: "ChartLyrics" };
}

// Race all sources simultaneously — first with real lyrics wins
async function fetchLyricsRace(artist, title) {
  const norm = normalizeTitle(title);
  try {
    return await Promise.any([
      fetchFromTamil2Lyrics(artist, norm),
      fetchFromLrclib(artist, norm),
      fetchFromOvh(artist, norm),
      fetchFromSRA(artist, norm),
      fetchFromChartLyrics(artist, norm),
    ]);
  } catch {
    // Last resort: retry with title only (no artist) — helps regional songs
    try {
      return await Promise.any([
        fetchFromTamil2Lyrics("", norm),
        fetchFromLrclib("", norm),
        fetchFromSRA("", norm),
      ]);
    } catch { return null; }
  }
}

// Fetch explicitly from one named source (manual switcher in UI)
async function fetchLyricsFromSource(artist, title, source) {
  const norm = normalizeTitle(title);
  try {
    if (source === "tamil2lyrics")    return await fetchFromTamil2Lyrics(artist, norm);
    if (source === "lrclib")          return await fetchFromLrclib(artist, norm);
    if (source === "lyrics.ovh")      return await fetchFromOvh(artist, norm);
    if (source === "some-random-api") return await fetchFromSRA(artist, norm);
    if (source === "ChartLyrics")     return await fetchFromChartLyrics(artist, norm);
  } catch {}
  return null;
}

function ugLink(title, artist)    { return `https://www.ultimate-guitar.com/search.php?title=${encodeURIComponent(title)}&performer=${encodeURIComponent(artist)}`; }
function torrinsLink(title)        { return `https://www.torrins.com/guitar-lessons/?s=${encodeURIComponent(title)}`; }
function geniusLink(title, artist) { return `https://genius.com/search?q=${encodeURIComponent(title + ' ' + artist)}`; }

// ── Chord-availability check (one source wins, cached per song) ───────
const getChordCache = ()    => LS.get("jb_chordcache", {});
const saveChordCache = c    => LS.set("jb_chordcache", c);

// Race three chord sites: first one with results wins. Returns {source, url} or null.
async function checkChordsAvailable(title, artist) {
  const tryUG = async () => {
    const url = ugLink(title, artist);
    const r = await fetch(CORS_PROXY + encodeURIComponent(url));
    if (!r.ok) throw new Error("ug fail");
    const html = await r.text();
    // UG embeds search results JSON in the page; an empty result has "results":[]
    if (/"results":\s*\[(?!\s*\])/.test(html) || /\/tab\/(chords|tabs|crd)\//i.test(html)) {
      return { source: "Ultimate Guitar", url };
    }
    throw new Error("ug no results");
  };
  const tryTorrins = async () => {
    const url = torrinsLink(title);
    const r = await fetch(CORS_PROXY + encodeURIComponent(url));
    if (!r.ok) throw new Error("torrins fail");
    const html = await r.text();
    if (/Nothing Found|No results|No posts/i.test(html)) throw new Error("torrins empty");
    if (/class="[^"]*entry-title|<article|guitar-lessons\/[a-z]/i.test(html)) {
      return { source: "Torrins", url };
    }
    throw new Error("torrins no results");
  };
  const tryGenius = async () => {
    const url = geniusLink(title, artist);
    const r = await fetch(CORS_PROXY + encodeURIComponent(url));
    if (!r.ok) throw new Error("genius fail");
    const html = await r.text();
    if (/class="[^"]*mini_card|search_result/i.test(html)) {
      return { source: "Genius", url };
    }
    throw new Error("genius no results");
  };
  try { return await Promise.any([tryUG(), tryTorrins(), tryGenius()]); }
  catch { return null; }
}

// ─── LocalStorage ─────────────────────────────────────────────────────
const LS = { get:(k,d)=>{ try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch{return d} }, set:(k,v)=>{ try{localStorage.setItem(k,JSON.stringify(v))}catch{} } };
const getUsers          = ()    => LS.get("jb_users",[]);
const saveUsers         = u     => LS.set("jb_users",u);
const getSession        = ()    => LS.get("jb_session",null);
const saveSession       = s     => LS.set("jb_session",s);
const getUserFolders    = uid   => LS.get(`jb_folders_${uid}`,[]);
const saveUserFolders   = (u,f) => LS.set(`jb_folders_${u}`,f);
const getSharedFolders  = ()    => LS.get("jb_shared",{});
const saveSharedFolders = s     => LS.set("jb_shared",s);

// ── URL-based folder sharing — works across devices/browsers ──────────
// The link itself carries the folder data (base64-encoded JSON in ?share=).
// This sidesteps localStorage (which is per-device) so a friend can paste
// the link in their browser and import — no backend required.
function encodeShareLink(folder, user, songs) {
  const payload = {
    v: 1,
    ownerName: user.username,
    folderName: folder.name,
    songs: songs.map(s => ({
      id:       s.id,
      type:     s.type || "live",
      title:    s.title,
      artist:   s.artist || s.singer || "",
      album:    s.album  || s.movie  || "",
      cover:    s.cover  || "",
      language: s.language || "",
    })),
  };
  const json = JSON.stringify(payload);
  // UTF-8 safe base64
  const b64  = btoa(unescape(encodeURIComponent(json)))
                  .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const base = window.location.origin + window.location.pathname;
  return `${base}?share=${b64}`;
}

function decodeShareFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const b64 = params.get("share");
  if (!b64) return null;
  try {
    const padded = b64.replace(/-/g,"+").replace(/_/g,"/")
                      + "===".slice(0, (4 - b64.length % 4) % 4);
    const json = decodeURIComponent(escape(atob(padded)));
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
// Pre-fetch lyrics silently and store in cache (called when song added to folder)
function preFetchLyrics(song) {
  if (song.type !== "live") return;
  if (getCachedLyrics(song.id)) return; // already cached
  fetchLyricsRace(song.artist, song.title).then(result => {
    if (result) setCachedLyrics(song.id, result);
  });
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
    // Default starter folder for every new account
    try { await this.createFolder(session, "Vibe List"); } catch (e) { console.warn("Default folder failed:", e); }
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
        songs: r.songs || [],
        shareCode: r.share_token || null,
      }));
    }
    // Local: migrate old songIds → songs (resolve from cache)
    const fs = getUserFolders(user.id);
    return fs.map(f => {
      if (f.songs) return f;
      const songs = (f.songIds || []).map(id => resolveSongById(id)).filter(Boolean);
      return { id: f.id, name: f.name, songs, shareCode: f.shareCode || null };
    });
  },

  async createFolder(user, name) {
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
    if (HAS_SUPABASE) {
      const { error } = await sb.from("folders")
        .update({ name: folder.name, songs: folder.songs, share_token: folder.shareCode })
        .eq("id", folder.id).eq("user_id", user.id);
      if (error) console.error(error);
      return;
    }
    const all = getUserFolders(user.id);
    saveUserFolders(user.id, all.map(x => x.id === folder.id ? folder : x));
  },

  async deleteFolder(user, folderId) {
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

// One-time migration: strip demo users + curated song references from prior versions
(function migrate(){
  const users = getUsers();
  const cleaned = users.filter(u => !((u.id===1||u.id===2) && u.password==="demo123"));
  if (cleaned.length !== users.length) {
    saveUsers(cleaned);
    try { localStorage.removeItem("jb_folders_1"); } catch {}
    try { localStorage.removeItem("jb_folders_2"); } catch {}
  }
  for (const u of cleaned) {
    const fs = getUserFolders(u.id);
    let dirty = false;
    const cleanedFs = fs.map(f => {
      const newIds = f.songIds.filter(id => !String(id).startsWith("c"));
      if (newIds.length !== f.songIds.length) dirty = true;
      return { ...f, songIds: newIds };
    });
    if (dirty) saveUserFolders(u.id, cleanedFs);
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
function ShareModal({folder, user, onClose, showToast, folderSongs}) {
  const shareUrl = React.useMemo(
    () => encodeShareLink(folder, user, folderSongs || []),
    [folder, user, folderSongs]
  );

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
    <div className={`flex items-center gap-2 bg-[#1a1a2e] border rounded-xl px-3 py-2 ${on?"border-violet-500 scroll-active":"border-[#2e2e44]"}`}>
      <span className="text-xs text-gray-400 font-medium">Auto-Scroll</span>
      <div className="flex gap-1">
        {SCROLL_SPEEDS.map(s=>(
          <button key={s.key} onClick={()=>setSpeed(s.key)}
            className={`speed-btn text-xs px-2 py-1 rounded-lg border font-medium transition-all ${speed===s.key?"active border-violet-600":"border-[#2e2e44] text-gray-400 hover:border-gray-500"}`}>{s.label}</button>
        ))}
      </div>
      <button onClick={()=>setOn(v=>!v)}
        className={`ml-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all text-white ${on?"bg-red-600 hover:bg-red-700":"bg-violet-600 hover:bg-violet-700"}`}>
        {on?"⏹ Stop":"▶ Start"}
      </button>
    </div>
  );
}

// ─── Queue Panel ──────────────────────────────────────────────────────
function FolderQueuePanel({folder,folderSongs,activeSongId,onOpenSong}) {
  return (
    <div className="w-52 flex-shrink-0 bg-[#0d0d18] border-l border-[#1a1a2a] flex flex-col h-full">
      <div className="px-4 py-4 border-b border-[#1a1a2a]">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-0.5">Session Queue</div>
        <div className="text-sm font-semibold text-violet-300 truncate">📁 {folder.name}</div>
        <div className="text-xs text-gray-600 mt-0.5">{folderSongs.length} songs</div>
      </div>
      <div className="flex-1 overflow-y-auto py-3 px-2 space-y-1.5">
        {folderSongs.map((song,i)=>{
          const isActive = song.id===activeSongId;
          return (
            <div key={song.id} onClick={()=>onOpenSong(song)}
              className={`queue-song relative cursor-pointer rounded-lg border px-3 py-2.5 transition-all ${isActive?"queue-song-active":"border-[#1e1e2e] hover:bg-[#1a1a2e]"}`}>
              {isActive&&<div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-violet-500 rounded-r-full"/>}
              <div className="flex items-start gap-2 pl-1">
                <span className={`text-xs font-bold mt-0.5 w-4 flex-shrink-0 ${isActive?"text-violet-400":"text-gray-700"}`}>{i+1}</span>
                <div className="min-w-0">
                  <div className={`text-xs font-semibold leading-tight truncate ${isActive?"text-violet-200":"text-gray-300"}`}>{song.title}</div>
                  <div className="text-xs text-gray-600 truncate mt-0.5">{song.artist||song.singer}</div>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full mt-1 inline-block ${isActive?"curated-badge":"text-gray-600 bg-gray-800"}`}>
                    {song.type==="curated"?"⭐ Curated":"🎵 Live"}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-4 py-3 border-t border-[#1a1a2a]">
        <div className="text-xs text-gray-600 font-semibold mb-2">Vocal Parts</div>
        <div className="flex flex-wrap gap-1">
          {Object.entries(TAG_CONFIG).map(([k,v])=>(
            <span key={k} className={`text-xs px-2 py-0.5 rounded-full ${v.class}`}>{v.label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Curated Song View ────────────────────────────────────────────────
function CuratedSongView({song,onBack,onAddToFolder,folders,activeFolder,folderSongs,onOpenSong}) {
  const [showChords,setShowChords]   = React.useState(true);
  const [script,setScript]           = React.useState("roman");
  const [showFolderMenu,setFolderMenu] = React.useState(false);
  const scrollRef = React.useRef(null);

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
          <div className="ml-auto"><AutoScrollControl scrollRef={scrollRef}/></div>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-1">
          {song.lines.map(line=>(
            <div key={line.id} className="lyric-line px-3 py-2 transition-all">
              {showChords&&<div className="mb-0.5"><ChordBadge chord={line.chord}/></div>}
              <div className="flex items-center gap-3">
                <Tag type={line.tag}/>
                <span className={`text-base leading-relaxed font-medium text-gray-100 ${script==="native"?"tamil-text":""}`}>
                  {script==="native"?line.textNative:line.textRoman}
                </span>
              </div>
            </div>
          ))}
          <div className="h-16"/>
        </div>
      </div>
      {activeFolder&&folderSongs&&folderSongs.length>0&&(
        <FolderQueuePanel folder={activeFolder} folderSongs={folderSongs} activeSongId={song.id} onOpenSong={onOpenSong}/>
      )}
    </div>
  );
}

// ─── Chord-finder button — racing UG / Torrins / Genius ──────────────
function ChordButton({ song }) {
  const cacheKey = `${song.title}::${song.artist || song.singer || ""}`;
  const cached   = getChordCache()[cacheKey];
  const [state, setState] = React.useState(
    cached === undefined ? "checking" : (cached ? "found" : "missing")
  );
  const [result, setResult] = React.useState(cached || null);

  React.useEffect(() => {
    if (state !== "checking") return;
    let alive = true;
    checkChordsAvailable(song.title, song.artist || song.singer || "").then(r => {
      if (!alive) return;
      const c = getChordCache(); c[cacheKey] = r || null; saveChordCache(c);
      setResult(r); setState(r ? "found" : "missing");
    });
    return () => { alive = false; };
  }, [cacheKey]);

  if (state === "checking") {
    return (
      <button disabled
        className="text-xs px-2.5 py-1.5 rounded-lg border border-[#2e2e44] text-gray-500 cursor-wait flex items-center gap-1.5">
        <div className="w-3 h-3 border border-violet-500 border-t-transparent rounded-full animate-spin"/>
        Finding chords…
      </button>
    );
  }
  if (state === "missing") {
    return (
      <button disabled title="No chords found across Ultimate Guitar, Torrins, Genius"
        className="text-xs px-2.5 py-1.5 rounded-lg border border-[#2a2a3e] text-gray-700 opacity-50 cursor-not-allowed">
        🎸 No chords found
      </button>
    );
  }
  return (
    <a href={result.url} target="_blank" rel="noopener"
      title={`Chords found on ${result.source}`}
      className="text-xs px-2.5 py-1.5 rounded-lg bg-amber-600/20 border border-amber-500/50 text-amber-300 hover:bg-amber-600/30 transition-all font-medium">
      🎸 Chords on {result.source} ↗
    </a>
  );
}

// ─── Live Song View (iTunes) ──────────────────────────────────────────
function LiveSongView({song,onBack,onAddToFolder,folders,activeFolder,folderSongs,onOpenSong}) {
  const [lyricsData, setLyricsData] = React.useState(null); // {lyrics, source}
  const [loading,    setLoading]    = React.useState(true);
  const [notFound,   setNotFound]   = React.useState(false);
  const [switching,  setSwitching]  = React.useState(false);
  const [showFolderMenu, setFolderMenu] = React.useState(false);
  const [script,     setScript]     = React.useState("roman"); // "roman" | "native"
  const [wasCached,  setWasCached]  = React.useState(false);
  const [googleRoman,setGoogleRoman]= React.useState(null);   // best-quality version
  const [romanizing, setRomanizing] = React.useState(false);
  const scrollRef = React.useRef(null);

  // Re-read cache + reset state whenever song.id changes
  React.useEffect(() => {
    setGoogleRoman(null); setRomanizing(false);
    const cached = getCachedLyrics(song.id);
    if (cached) {
      setLyricsData(cached); setLoading(false); setNotFound(false); setWasCached(true);
      if (cached.googleRoman) setGoogleRoman(cached.googleRoman); // already enhanced
      return;
    }
    setLyricsData(null); setLoading(true); setNotFound(false); setWasCached(false);
    fetchLyricsRace(song.artist, song.title).then(result => {
      if (result) { setLyricsData(result); setCachedLyrics(song.id, result); }
      else        { setNotFound(true); }
      setLoading(false);
    });
  }, [song.id]);

  // Switch source manually
  const switchSource = async (src) => {
    setSwitching(true); setGoogleRoman(null);
    const result = await fetchLyricsFromSource(song.artist, song.title, src);
    if (result) { setLyricsData(result); setCachedLyrics(song.id, result); setNotFound(false); }
    else        { setNotFound(true); setLyricsData(null); }
    setSwitching(false);
  };

  const otherSources = LYRIC_SOURCES.filter(s => s !== lyricsData?.source);

  // If source returned pre-Romanized text (e.g. tamil2lyrics), the toggle is hidden.
  const preRomanized = !!lyricsData?.alreadyRomanized;
  const nativeScript = (!preRomanized && lyricsData?.lyrics) ? detectScript(lyricsData.lyrics) : null;

  // Kick off Google romanization once lyrics arrive (if needed and not cached).
  React.useEffect(() => {
    if (!lyricsData?.lyrics || preRomanized || !nativeScript) return;
    if (googleRoman) return; // already have it
    setRomanizing(true);
    googleRomanize(lyricsData.lyrics).then(roman => {
      setRomanizing(false);
      if (roman) {
        setGoogleRoman(roman);
        // Persist alongside the cached lyrics object
        setCachedLyrics(song.id, { ...lyricsData, googleRoman: roman });
      }
    });
  }, [lyricsData, nativeScript, preRomanized]);

  const displayText = React.useMemo(() => {
    if (!lyricsData?.lyrics) return null;
    if (preRomanized) return lyricsData.lyrics;
    if (script === "roman" && nativeScript) {
      // Prefer Google's natural output; fall back to rule-based until it arrives
      return googleRoman || transliterateLocal(lyricsData.lyrics);
    }
    return lyricsData.lyrics;
  }, [lyricsData, script, nativeScript, preRomanized, googleRoman]);

  const stanzas = displayText ? parseStructured(displayText) : [];

  const isMobile = useIsMobile();
  const [showQueue, setShowQueue] = React.useState(false);
  const [showSourceMenu, setShowSourceMenu] = React.useState(false);
  const hasQueue = activeFolder && folderSongs && folderSongs.length > 0;

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">

        {/* Header — compact, single-row title on mobile */}
        <div className="px-4 sm:px-5 pt-3 sm:pt-4 pb-2 sm:pb-3 border-b border-[#1e1e2e] flex-shrink-0">
          <div className="flex items-center justify-between gap-2">
            <button onClick={onBack} title="Back" className="text-violet-400 hover:text-violet-300 text-sm sm:text-xs flex-shrink-0">←</button>
            <div className="flex-1 min-w-0">
              <h1 className="text-base sm:text-xl font-bold text-white truncate">{song.title}</h1>
              <div className="text-xs text-gray-500 truncate">🎤 {song.artist}</div>
            </div>
            <div className="flex gap-1.5 flex-shrink-0">
              <ChordButton song={song} />
              <div className="relative">
                <button onClick={()=>setFolderMenu(v=>!v)}
                  className="text-xs px-2 py-1.5 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-violet-500 hover:text-violet-400 transition-all">📁</button>
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
              {isMobile && hasQueue && (
                <button onClick={()=>setShowQueue(true)} title="Session queue"
                  className="text-xs px-2 py-1.5 rounded-lg border border-violet-500/40 text-violet-400 hover:bg-violet-600/10 transition-all">
                  ☰ {folderSongs.length}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Source bar — compact toolbar, full bar on desktop / inline icons on mobile */}
        <div className="px-4 sm:px-5 py-1.5 sm:py-2 border-b border-[#1a1a2a] flex items-center gap-2 sm:gap-3 flex-shrink-0">
          {nativeScript && (
            <div className="script-toggle">
              <div onClick={()=>setScript("roman")} className={`script-opt ${script==="roman"?"active":""}`}>{isMobile?"Aa":"Romanized"}</div>
              <div onClick={()=>setScript("native")} className={`script-opt ${script==="native"?"active":""}`}>{isMobile?"அ":"Native"}</div>
            </div>
          )}

          {/* Source switcher — full on desktop, collapsed dropdown on mobile */}
          {!isMobile && (
            <>
              <span className="text-xs text-gray-600">Source:</span>
              {lyricsData?.source && (
                <span className="text-xs px-2 py-1 rounded-lg bg-violet-900/30 text-violet-300 border border-violet-700/30 font-medium">
                  ✓ {lyricsData.source}
                </span>
              )}
              {!loading && !switching && otherSources.map(src => (
                <button key={src} onClick={()=>switchSource(src)}
                  className="text-xs px-2 py-1 rounded-lg border border-[#2e2e44] text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-all">
                  Try {src}
                </button>
              ))}
              {nativeScript && script === "roman" && (
                romanizing
                  ? <span className="text-xs text-gray-500 flex items-center gap-1 ml-1"><div className="w-3 h-3 border border-violet-500 border-t-transparent rounded-full animate-spin"/>Enhancing…</span>
                  : googleRoman
                    ? <span className="text-xs text-violet-400 ml-1">✨ Smart</span>
                    : <span className="text-xs text-gray-600 ml-1">· basic</span>
              )}
            </>
          )}
          {isMobile && lyricsData?.source && (
            <div className="relative">
              <button onClick={()=>setShowSourceMenu(v=>!v)}
                className="text-xs px-2 py-1 rounded-lg bg-violet-900/30 text-violet-300 border border-violet-700/30 font-medium flex items-center gap-1">
                {lyricsData.source} ▾
              </button>
              {showSourceMenu && (
                <div className="absolute left-0 top-full mt-1 bg-[#1a1a2e] border border-[#2e2e44] rounded-xl shadow-xl z-50 min-w-40">
                  {otherSources.map(src => (
                    <button key={src} onClick={()=>{switchSource(src);setShowSourceMenu(false);}}
                      className="w-full text-left px-4 py-2 text-xs text-gray-300 hover:bg-violet-600/20 first:rounded-t-xl last:rounded-b-xl">
                      Try {src}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {switching && <span className="text-xs text-gray-500 flex items-center gap-1"><div className="w-3 h-3 border border-violet-500 border-t-transparent rounded-full animate-spin"/></span>}

          <div className="ml-auto"><AutoScrollControl scrollRef={scrollRef}/></div>
        </div>

        {/* Lyrics body */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-5">
          {loading && (
            <div className="space-y-3">
              <Spinner/>
              <p className="text-center text-xs text-gray-600">Checking tamil2lyrics, lrclib, lyrics.ovh, some-random-api, ChartLyrics simultaneously…</p>
            </div>
          )}
          {!loading && notFound && (
            <div className="text-center py-16">
              <div className="text-5xl mb-4">🎵</div>
              <p className="text-gray-300 font-semibold text-base mb-1">Couldn't find lyrics for this song</p>
              <p className="text-gray-600 text-sm mb-6">All 4 sources were tried simultaneously</p>
              <button
                onClick={() => {
                  setNotFound(false); setLoading(true);
                  fetchLyricsRace(song.artist, song.title).then(result => {
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
            <div className="max-w-3xl mx-auto">
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
        <FolderQueuePanel folder={activeFolder} folderSongs={folderSongs} activeSongId={song.id} onOpenSong={onOpenSong}/>
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
            <div className="flex-1 overflow-y-auto py-3 px-2 space-y-1.5">
              {folderSongs.map((s, i) => {
                const isActive = s.id === song.id;
                return (
                  <div key={s.id} onClick={()=>{onOpenSong(s); setShowQueue(false);}}
                    className={`queue-song relative cursor-pointer rounded-lg border px-3 py-2.5 transition-all ${isActive?"queue-song-active":"border-[#1e1e2e]"}`}>
                    <div className="flex items-start gap-2">
                      <span className={`text-xs font-bold mt-0.5 w-4 flex-shrink-0 ${isActive?"text-violet-400":"text-gray-700"}`}>{i+1}</span>
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm font-semibold leading-tight truncate ${isActive?"text-violet-200":"text-gray-300"}`}>{s.title}</div>
                        <div className="text-xs text-gray-600 truncate mt-0.5">{s.artist || s.singer}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Folder View ──────────────────────────────────────────────────────
function FolderView({folder,songs,onOpenSong,onRemove,onBack}) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 pt-3 sm:pt-5 pb-3 sm:pb-4 border-b border-[#1e1e2e]">
        <div className="flex items-center gap-3">
          <button onClick={onBack} title="Back" className="text-violet-400 hover:text-violet-300 text-lg">←</button>
          <div className="min-w-0 flex-1">
            <h2 className="text-base sm:text-xl font-bold text-white truncate">📁 {folder.name}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{songs.length} song{songs.length!==1?"s":""}</p>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-5 space-y-2 sm:space-y-3">
        {songs.length===0&&(
          <div className="text-center py-16 text-gray-500">
            <div className="text-4xl mb-3">🎵</div>
            <p>No songs yet. Search and add some!</p>
          </div>
        )}
        {songs.map((song,i)=>(
          <div key={song.id} className="flex items-center justify-between bg-[#1a1a2e] border border-[#2e2e44] rounded-xl px-4 py-3 hover:border-violet-500/40 transition-all">
            <div className="flex items-center gap-3 flex-1 cursor-pointer" onClick={()=>onOpenSong(song)}>
              <span className="text-xl font-bold text-violet-800 w-6">{i+1}</span>
              <div className="min-w-0">
                <div className="font-semibold text-white truncate">{song.title}</div>
                <div className="text-xs text-gray-400">{song.artist||song.singer} · {song.language||"Unknown"}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 ml-2">
              <span className={`text-xs px-2 py-0.5 rounded-full ${song.type==="curated"?"curated-badge":"live-badge"}`}>
                {song.type==="curated"?"⭐":"🎵"}
              </span>
              <button onClick={()=>onRemove(folder.id,song.id)} className="text-gray-600 hover:text-red-400 text-sm px-1.5 transition-all">✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Search Page ──────────────────────────────────────────────────────
function SearchPage({onOpenSong,folders,onAddToFolder,user,onSelectFolder,onCreateFolder,onShareFolder,onLogout}) {
  const username = user.username;
  const [query,setQuery]              = React.useState("");
  const [filterBy,setFilterBy]        = React.useState("title");
  const [allResults, setAllResults]   = React.useState([]); // full pool
  const [loading,setLoading]          = React.useState(false);
  const [creatingFolder,setCreating]  = React.useState(false);
  const [newFolderName,setNewName]    = React.useState("");
  const [showMenu,setShowMenu]        = React.useState(null);
  const [inlineNewFolder, setInlineNewFolder] = React.useState(null);
  const [page, setPage]               = React.useState(0);
  const debounceRef = React.useRef(null);
  const resultsTopRef = React.useRef(null);

  // Reset to page 0 whenever the query/filter changes
  React.useEffect(()=>{ setPage(0); }, [query, filterBy]);

  // Fetch the full pool when the query changes — iTunes has no offset param,
  // so we ask for 200 results and paginate locally.
  React.useEffect(()=>{
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim() || query.trim().length<2) { setAllResults([]); return; }
    setLoading(true);
    debounceRef.current = setTimeout(async()=>{
      const results = await searchSongs(query);
      setAllResults(results);
      setLoading(false);
    }, 600);
    return ()=>clearTimeout(debounceRef.current);
  },[query]);

  // Slice the current page out of the pool
  const liveResults = React.useMemo(
    () => allResults.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [allResults, page]
  );
  const totalPages  = Math.max(1, Math.ceil(allResults.length / PAGE_SIZE));
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

  const searchInput = (
    <div className="flex gap-2 max-w-xl mx-auto w-full">
      <input value={query} onChange={e=>setQuery(e.target.value)} autoFocus={!isMobile}
        placeholder={`Search by ${filterBy}…`}
        className={`flex-1 bg-[#1a1a2e] border border-[#2e2e44] rounded-xl px-4 ${isMobile?"py-2.5":"py-3"} text-white placeholder-gray-500 text-sm transition-all ${isMobile?"":"text-center"}`} />
      <select value={filterBy} onChange={e=>setFilterBy(e.target.value)}
        className={`bg-[#1a1a2e] border border-[#2e2e44] rounded-xl px-3 ${isMobile?"py-2.5":"py-3"} text-gray-300 text-sm cursor-pointer`}>
        <option value="title">Title</option>
        <option value="movie">Movie</option>
        <option value="singer">Singer</option>
        <option value="composer">Composer</option>
      </select>
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden" onClick={()=>{setShowMenu(null); setShowAccount(false);}}>
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
            <div className="absolute right-0 top-full mt-1 bg-[#1a1a2e] border border-[#2e2e44] rounded-xl shadow-xl z-50 min-w-48 overflow-hidden">
              <div className="px-4 py-3 border-b border-[#2e2e44]">
                <div className="text-sm font-semibold text-white">{username}</div>
                <div className="text-xs text-gray-500 mt-0.5">{folders.length} folder{folders.length!==1?"s":""}</div>
              </div>
              <button onClick={onLogout}
                className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-all">
                ⎋ Sign out
              </button>
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
            <p className="text-gray-500 text-sm mb-6">Search any song · lyrics from lrclib, lyrics.ovh & more</p>
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

      <div className={`flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-6 ${isMobile?"pb-28":""}`}>
        {/* Live results — only when searching */}
        {hasQuery && (
          <div ref={resultsTopRef} className="max-w-3xl mx-auto mb-8">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">🎵 Search Results</span>
              {loading
                ? <div className="w-3 h-3 border border-violet-500 border-t-transparent rounded-full animate-spin"/>
                : <span className="text-xs px-2 py-0.5 rounded-full live-badge">{allResults.length} total</span>}
              {totalPages > 1 && <span className="text-xs text-gray-600">· Page {page+1} of {totalPages}</span>}
            </div>
            {!loading && liveResults.length===0 && <p className="text-xs text-gray-600 py-2">No songs found.</p>}
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
                    <button
                      onClick={e => { e.stopPropagation(); onShareFolder(f); }}
                      title="Share folder"
                      className="text-xs px-2 py-1 rounded-lg border border-[#2e2e44] text-gray-400 hover:border-violet-500 hover:text-violet-400 transition-all">
                      ↗ Share
                    </button>
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
function Sidebar({user,folders,activeFolderId,onSelectFolder,onCreateFolder,onDeleteFolder,onShareFolder,onShowImport,activeView,onGoSearch,collapsed,onToggleCollapse,onLogout}) {
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

// ─── App Root ─────────────────────────────────────────────────────────
function App() {
  const [user, setUser]                    = React.useState(null);
  const [bootLoading, setBootLoading]      = React.useState(true);
  const [view,setView]                     = React.useState("search");
  const [activeSong,setActiveSong]         = React.useState(null);
  const [activeFolderId,setActiveFolderId] = React.useState(null);
  const [sidebarCollapsed,setSidebarCollapsed] = React.useState(false);
  const [folders,setFolders]               = React.useState([]);
  const [shareTarget,setShareTarget]       = React.useState(null);
  const [showImport,setShowImport]         = React.useState(false);
  const [pendingShare,setPendingShare]     = React.useState(null);
  const [toast,showToast]                  = useToast();

  // Restore session on first load
  React.useEffect(() => {
    (async () => {
      const sess = await db.restoreSession();
      if (sess) setUser(sess);
      setBootLoading(false);
    })();
  }, []);

  // Load folders from db whenever user changes
  React.useEffect(() => {
    if (!user) { setFolders([]); return; }
    (async () => {
      const fs = await db.getFolders(user);
      setFolders(fs);
    })();
  }, [user?.id]);

  // Detect ?share= URL on first load
  React.useEffect(() => {
    const data = decodeShareFromUrl();
    if (data) setPendingShare(data);
  }, []);

  // Once a user is logged in AND we have a pending share, open the import modal
  React.useEffect(() => {
    if (user && pendingShare) setShowImport(true);
  }, [user, pendingShare]);

  const logout = async () => {
    await db.signOut();
    setUser(null); setFolders([]); setView("search");
    setActiveSong(null); setActiveFolderId(null); setSidebarCollapsed(false);
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

  const addToFolder = async (fid, song) => {
    cacheSong(song);
    let updated;
    setFolders(f => {
      const next = f.map(x => {
        if (x.id !== fid) return x;
        if (x.songs.some(s => s.id === song.id)) return x;
        const newF = { ...x, songs: [...x.songs, song] };
        updated = newF;
        return newF;
      });
      return next;
    });
    preFetchLyrics(song);
    showToast(`Added "${song.title}" to folder`);
    if (updated) await db.updateFolder(user, updated);
  };

  const removeFromFolder = async (fid, sid) => {
    let updated;
    setFolders(f => f.map(x => {
      if (x.id !== fid) return x;
      const newF = { ...x, songs: x.songs.filter(s => s.id !== sid) };
      updated = newF;
      return newF;
    }));
    if (updated) await db.updateFolder(user, updated);
  };

  const selectFolder = id => { setActiveFolderId(id); setView("folder"); };

  const importFolder = async (entry) => {
    const songs = (entry.songs || []).map(s => ({ ...s, type: s.type || "live" }));
    songs.forEach(cacheSong);
    const newF = await db.createFolder(user, `${entry.folderName} (${entry.ownerName})`);
    newF.songs = songs;
    await db.updateFolder(user, newF);
    setFolders(f => [...f, newF]);
    setPendingShare(null);
    clearShareFromUrl();
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
  };

  const activeFolder = folders.find(f => f.id === activeFolderId);
  const folderSongs  = activeFolder ? activeFolder.songs : [];

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
  const isMobile = useIsMobile();
  const showSidebar = view !== "search" && !isMobile;

  return (
    <div className="flex h-screen overflow-hidden">
      {showSidebar && (
        <Sidebar
          user={user} folders={folders} activeFolderId={activeFolderId}
          onSelectFolder={selectFolder} onCreateFolder={createFolder} onDeleteFolder={deleteFolder}
          onShareFolder={setShareTarget} onShowImport={()=>setShowImport(true)}
          activeView={view} onGoSearch={()=>{setView("search");setActiveFolderId(null);}}
          collapsed={sidebarCollapsed} onToggleCollapse={()=>setSidebarCollapsed(v=>!v)}
          onLogout={logout}
        />
      )}
      <main className="flex-1 overflow-hidden flex flex-col min-w-0">
        {view==="search"&&(
          <SearchPage onOpenSong={openSong} folders={folders} onAddToFolder={addToFolder} user={user} onSelectFolder={selectFolder} onCreateFolder={createFolder} onShareFolder={setShareTarget} onLogout={logout}/>
        )}
        {view==="song"&&activeSong&&activeSong.type==="curated"&&(
          <CuratedSongView
            song={activeSong} onBack={()=>setView("search")} folders={folders} onAddToFolder={addToFolder}
            activeFolder={activeFolder} folderSongs={folderSongs} onOpenSong={s=>openSong(s,activeFolderId)}
          />
        )}
        {view==="song"&&activeSong&&activeSong.type==="live"&&(
          <LiveSongView
            song={activeSong} onBack={()=>setView("search")} folders={folders} onAddToFolder={addToFolder}
            activeFolder={activeFolder} folderSongs={folderSongs} onOpenSong={s=>openSong(s,activeFolderId)}
          />
        )}
        {view==="folder"&&activeFolder&&(
          <FolderView
            folder={activeFolder} songs={folderSongs}
            onOpenSong={s=>openSong(s,activeFolder.id)}
            onRemove={removeFromFolder}
            onBack={()=>{setView("search");setActiveFolderId(null);}}
          />
        )}
      </main>

      {shareTarget && (
        <ShareModal
          folder={shareTarget}
          user={user}
          folderSongs={shareTarget.songs || []}
          onClose={()=>setShareTarget(null)}
          showToast={showToast}
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
      {toast&&<div className="toast">{toast}</div>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
