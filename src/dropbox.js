// Dropbox との読み書き。試験モード（__MOCK__）では PC のフォルダを読むだけの「もどき」に差し替える。
// トークンはこの端末の IndexedDB にだけ保存する（サーバーにもリポジトリにも置かない）。
import { get, set, del, createStore, entries } from 'idb-keyval';

export const isMock = __MOCK__;
const APP_KEY = import.meta.env.VITE_DROPBOX_APP_KEY || '';
const REDIRECT_URI = location.origin + import.meta.env.BASE_URL;
const TOKEN_KEY = 'dbx-token';
const API = 'https://api.dropboxapi.com/2/';
const CONTENT = 'https://content.dropboxapi.com/2/';

export class DbxError extends Error {
  constructor(summary, status) {
    super(summary);
    this.summary = summary || '';
    this.status = status;
  }
  get notFound() {
    return /not_found/.test(this.summary);
  }
}
export class NotLoggedIn extends Error {}

export const hasAppKey = () => isMock || !!APP_KEY;

// Dropbox-API-Arg ヘッダーは ASCII しか通らないので、日本語は \uXXXX にする
const headerArg = (obj) =>
  JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- ログイン（PKCE：App secret を使わない方式） ----------

export async function startLogin() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('pkce-verifier', verifier);
  const q = new URLSearchParams({
    client_id: APP_KEY,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    redirect_uri: REDIRECT_URI,
  });
  location.href = 'https://www.dropbox.com/oauth2/authorize?' + q;
}

async function tokenRequest(params) {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: APP_KEY, ...params }),
  });
  if (!res.ok) throw new DbxError('token/' + (await res.text()), res.status);
  return res.json();
}

/** Dropbox のログイン画面から戻ってきたときの処理。戻りでなければ何もしない */
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (!code && !q.get('error')) return;
  history.replaceState(null, '', REDIRECT_URI);
  const verifier = sessionStorage.getItem('pkce-verifier');
  sessionStorage.removeItem('pkce-verifier');
  if (!code || !verifier) return;
  const t = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
  await saveToken({ access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 });
}

let tokenCache = null;
async function saveToken(t) {
  tokenCache = t;
  await set(TOKEN_KEY, t);
}

export async function isLoggedIn() {
  if (isMock) return true;
  return !!(tokenCache || (await get(TOKEN_KEY)));
}

export async function logout() {
  if (isMock) return;
  try {
    await rpc('auth/token/revoke', null);
  } catch {}
  tokenCache = null;
  await del(TOKEN_KEY);
}

async function accessToken(forceRefresh = false) {
  const t = tokenCache || (tokenCache = await get(TOKEN_KEY));
  if (!t) throw new NotLoggedIn();
  if (forceRefresh || Date.now() > t.expiresAt - 60_000) {
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
    await saveToken({ ...t, access: r.access_token, expiresAt: Date.now() + r.expires_in * 1000 });
  }
  return tokenCache.access;
}

async function call(url, init) {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(attempt > 0);
    const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: 'Bearer ' + token } });
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) {
      let summary = '';
      try {
        summary = (await res.json()).error_summary;
      } catch {}
      throw new DbxError(summary || 'http/' + res.status, res.status);
    }
    return res;
  }
}

const rpc = async (endpoint, body) =>
  (
    await call(API + endpoint, {
      method: 'POST',
      headers: body === null ? {} : { 'Content-Type': 'application/json' },
      body: body === null ? undefined : JSON.stringify(body),
    })
  )
    .json()
    .catch(() => null);

const normalize = (e) => ({
  tag: e['.tag'],
  name: e.name,
  path: e.path_display,
  size: e.size,
  rev: e.rev,
});

// ---------- 本物の Dropbox ----------

const real = {
  async listFolder(path, { recursive = false } = {}) {
    let r = await rpc('files/list_folder', { path, recursive, limit: 2000 });
    const out = r.entries.map(normalize);
    while (r.has_more) {
      r = await rpc('files/list_folder/continue', { cursor: r.cursor });
      out.push(...r.entries.map(normalize));
    }
    return out;
  },
  download(path) {
    return call(CONTENT + 'files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': headerArg({ path }) } });
  },
  async tempLink(path) {
    return (await rpc('files/get_temporary_link', { path })).link;
  },
  async uploadText(path, text) {
    await call(CONTENT + 'files/upload', {
      method: 'POST',
      headers: {
        'Dropbox-API-Arg': headerArg({ path, mode: 'overwrite', mute: true }),
        'Content-Type': 'application/octet-stream',
      },
      body: new TextEncoder().encode(text),
    });
  },
  async thumbnail(path) {
    try {
      const res = await call(CONTENT + 'files/get_thumbnail_v2', {
        method: 'POST',
        headers: { 'Dropbox-API-Arg': headerArg({ resource: { '.tag': 'path', path }, format: 'jpeg', size: 'w480h320', mode: 'fitone_bestfit' }) },
      });
      return await res.blob();
    } catch {
      return null;
    }
  },
};

// ---------- 試験モード（PC のフォルダを読むだけ。書き込みはブラウザ内に残すだけ） ----------

const overlay = createStore('datsu-mock-overlay', 'files');
const mockUrl = (path) => import.meta.env.BASE_URL + '__mock/file?path=' + encodeURIComponent(path);

const mock = {
  async listFolder(path, { recursive = false } = {}) {
    const res = await fetch(import.meta.env.BASE_URL + '__mock/list?path=' + encodeURIComponent(path) + (recursive ? '&recursive=1' : ''));
    if (!res.ok) throw new DbxError('path/not_found/', 409);
    const out = (await res.json()).entries.map(normalize);
    const lower = path.toLowerCase();
    for (const [p, text] of await entries(overlay)) {
      const dir = p.slice(0, p.lastIndexOf('/')).toLowerCase();
      if ((dir === lower || (recursive && dir.startsWith(lower + '/'))) && !out.some((e) => e.path.toLowerCase() === p.toLowerCase())) {
        out.push({ tag: 'file', name: p.slice(p.lastIndexOf('/') + 1), path: p, size: text.length, rev: 'mock' });
      }
    }
    return out;
  },
  async download(path) {
    const text = await get(path, overlay);
    if (text !== undefined) return new Response(text);
    const res = await fetch(mockUrl(path));
    if (!res.ok) throw new DbxError('path/not_found/', 409);
    return res;
  },
  async tempLink(path) {
    return mockUrl(path);
  },
  async uploadText(path, text) {
    await set(path, text, overlay);
  },
  async thumbnail() {
    return null;
  },
};

export const dbx = isMock ? mock : real;

/** テキストを読む。ファイルがなければ null */
export async function downloadText(path) {
  try {
    return await (await dbx.download(path)).text();
  } catch (e) {
    if (e instanceof DbxError && e.notFound) return null;
    throw e;
  }
}
