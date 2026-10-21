// 音声プレーヤー。概要版は 1 本、網羅版は 1→2→3 と続けて流す。位置は本ごと・版ごとに記録する。
import { bookState, updateBook, kvGet, kvSet, localFile, touchDownload } from './store.js';
import { dbx } from './dropbox.js';
import { trackLabel } from './library.js';

export const SPEEDS = [0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2];
const SKIP = 15;

const audio = new Audio();
audio.preload = 'metadata';
let speed = 1;
let cur = null; // { book, kind, tracks, i }
let objectUrl = null;
let lastSave = 0;
const listeners = new Set();

export const onPlayer = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = (ev) => listeners.forEach((fn) => fn(ev));

export async function initPlayer() {
  speed = (await kvGet('speed')) || 1;
  setupMediaSession();
}

export function playerState() {
  return {
    book: cur?.book || null,
    kind: cur?.kind || null,
    i: cur?.i || 0,
    tracks: cur?.tracks || [],
    playing: !audio.paused,
    t: audio.currentTime || 0,
    d: isFinite(audio.duration) ? audio.duration : 0,
    speed,
  };
}

export const tracksOf = (book, kind) => (kind === 'summary' ? book.summary : book.full);

/** その本・その版の、記録してある再生位置 */
export function savedPosition(book, kind) {
  const p = bookState(book.key)?.audio?.[kind];
  if (!p || p.finished) return { i: 0, t: 0 };
  return { i: Math.min(p.i || 0, tracksOf(book, kind).length - 1), t: p.t || 0 };
}

function savePosition(extra = {}) {
  if (!cur) return;
  const st = bookState(cur.book.key) || {};
  updateBook(cur.book.key, {
    audio: { ...st.audio, [cur.kind]: { i: cur.i, t: Math.floor(audio.currentTime || 0), ...extra } },
    lastPlayed: Date.now(),
    kind: cur.kind,
  });
}

async function sourceFor(book, file) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  const local = await localFile(book.key, file.path);
  if (local) return (objectUrl = URL.createObjectURL(local));
  if (!navigator.onLine) throw new Error('この本はダウンロードされていません（オフライン中）');
  return dbx.tempLink(file.path);
}

/** 本の音声を読み込む。位置を省略したら記録してある位置から */
export async function loadAudio(book, kind, { i, t, autoplay = false } = {}) {
  const tracks = tracksOf(book, kind);
  if (!tracks.length) return;
  if (cur && audio.src) savePosition();
  if (i === undefined) ({ i, t } = savedPosition(book, kind));
  cur = { book, kind, tracks, i };
  emit('load');
  audio.src = await sourceFor(book, tracks[i]);
  audio.playbackRate = audio.defaultPlaybackRate = speed;
  await new Promise((ok, ng) => {
    audio.addEventListener('loadedmetadata', ok, { once: true });
    audio.addEventListener('error', () => ng(new Error('音声を読み込めませんでした')), { once: true });
  });
  if (t) audio.currentTime = Math.min(t, audio.duration - 1);
  const st = bookState(book.key) || {};
  const durations = st.durations || {};
  if (Math.round(durations[tracks[i].path] || 0) !== Math.round(audio.duration)) {
    updateBook(book.key, { durations: { ...durations, [tracks[i].path]: Math.round(audio.duration) } });
  }
  if (st.status === 'unread' || !st.status) updateBook(book.key, { status: 'reading', lastOpened: Date.now() });
  touchDownload(book.key);
  updateMetadata();
  emit('ready');
  if (autoplay) await play();
}

/** ダウンロード済みの音声の長さを先に読んでおく（本棚の進み具合バー用） */
export async function probeDurations(book) {
  for (const f of [...book.summary, ...book.full]) {
    if (bookState(book.key)?.durations?.[f.path]) continue;
    const file = await localFile(book.key, f.path);
    if (!file) continue;
    const url = URL.createObjectURL(file);
    const probe = new Audio();
    probe.preload = 'metadata';
    probe.src = url;
    const sec = await new Promise((ok) => {
      probe.onloadedmetadata = () => ok(probe.duration);
      probe.onerror = () => ok(0);
    });
    URL.revokeObjectURL(url);
    if (sec && isFinite(sec)) {
      const durations = bookState(book.key)?.durations || {};
      updateBook(book.key, { durations: { ...durations, [f.path]: Math.round(sec) } });
    }
  }
}

export async function play() {
  try {
    await audio.play();
  } catch (e) {
    emit({ error: e.message });
  }
}
export const pause = () => audio.pause();
export const toggle = () => (audio.paused ? play() : pause());
export const skip = (sec) => {
  audio.currentTime = Math.max(0, Math.min((audio.duration || 0) - 0.5, audio.currentTime + sec));
};
export const seek = (t) => {
  audio.currentTime = t;
};

export function setSpeed(v) {
  speed = v;
  audio.playbackRate = audio.defaultPlaybackRate = v;
  kvSet('speed', v);
  emit('speed');
}

export function selectTrack(i) {
  if (!cur) return;
  return loadAudio(cur.book, cur.kind, { i, t: 0, autoplay: !audio.paused });
}

audio.addEventListener('timeupdate', () => {
  emit('time');
  if (Date.now() - lastSave > 5000) {
    lastSave = Date.now();
    savePosition();
  }
  if ('mediaSession' in navigator && isFinite(audio.duration)) {
    try {
      navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: audio.currentTime });
    } catch {}
  }
});
audio.addEventListener('play', () => emit('state'));
audio.addEventListener('pause', () => {
  savePosition();
  emit('state');
});
audio.addEventListener('ended', () => {
  if (!cur) return;
  if (cur.i + 1 < cur.tracks.length) {
    loadAudio(cur.book, cur.kind, { i: cur.i + 1, t: 0, autoplay: true });
  } else {
    savePosition({ finished: true });
    emit('finished');
  }
});

// ---------- ロック画面・イヤホンからの操作 ----------

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const handlers = {
    play: () => play(),
    pause: () => pause(),
    seekbackward: () => skip(-SKIP),
    seekforward: () => skip(SKIP),
    seekto: (d) => seek(d.seekTime),
    previoustrack: () => cur && cur.i > 0 && selectTrack(cur.i - 1),
    nexttrack: () => cur && cur.i + 1 < cur.tracks.length && selectTrack(cur.i + 1),
  };
  for (const [k, fn] of Object.entries(handlers)) {
    try {
      ms.setActionHandler(k, fn);
    } catch {}
  }
}

let artworkUrl = null;
export function setArtwork(blob) {
  if (artworkUrl) URL.revokeObjectURL(artworkUrl);
  artworkUrl = blob ? URL.createObjectURL(blob) : null;
  updateMetadata();
}

function updateMetadata() {
  if (!('mediaSession' in navigator) || !cur) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: (cur.kind === 'summary' ? '概要版' : '網羅版') + '：' + trackLabel(cur.tracks[cur.i], cur.book.title),
    artist: cur.book.title,
    album: '脱ツンドク',
    artwork: artworkUrl ? [{ src: artworkUrl, sizes: '480x480', type: 'image/jpeg' }] : [],
  });
}
