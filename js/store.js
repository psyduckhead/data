// 数据存储：本地缓存 + 站点 data/games.json + GitHub API 同步

const LS = {
  db: 'mj.db',          // {games, pending:[id], deleted:[id]}
  settings: 'mj.settings',
  token: 'mj.token',
  apiKey: 'mj.apikey',
};

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function lsSet(key, val) {
  try {
    if (val == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(val));
  } catch (e) { console.warn('localStorage 不可用', e); }
}

export const store = {
  games: [],
  pending: new Set(),
  deleted: new Set(),
  remoteLoaded: false,

  async init() {
    const local = lsGet(LS.db, { games: [], pending: [], deleted: [] });
    this.pending = new Set(local.pending || []);
    this.deleted = new Set(local.deleted || []);
    let remote = null;
    try {
      const res = await fetch(`data/games.json?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) remote = await res.json();
    } catch { /* 离线或本地打开 */ }
    if (remote) {
      this.remoteLoaded = true;
      this.games = mergeGames(remote.games || [], local.games || [], this.pending, this.deleted);
    } else {
      this.games = local.games || [];
    }
    this.persist();
  },

  persist() {
    lsSet(LS.db, { games: this.games, pending: [...this.pending], deleted: [...this.deleted] });
  },

  get dirtyCount() { return this.pending.size + this.deleted.size; },

  getGame(id) { return this.games.find((g) => g.id === id); },

  saveGame(game) {
    game.updatedAt = new Date().toISOString();
    const i = this.games.findIndex((g) => g.id === game.id);
    if (i >= 0) this.games[i] = game; else this.games.push(game);
    this.pending.add(game.id);
    this.deleted.delete(game.id);
    this.persist();
  },

  deleteGame(id) {
    this.games = this.games.filter((g) => g.id !== id);
    this.pending.delete(id);
    this.deleted.add(id);
    this.persist();
  },

  importGames(list) {
    let n = 0;
    for (const g of list) {
      if (!g || !g.id || g.players?.length !== 4 || g.scores?.length !== 4) continue;
      const cur = this.getGame(g.id);
      if (!cur || (g.updatedAt || '') > (cur.updatedAt || '')) { this.saveGame({ ...g }); n++; }
    }
    return n;
  },

  sortedGames() {
    return this.games.slice().sort((a, b) => (a.date + (a.createdAt || '')).localeCompare(b.date + (b.createdAt || '')));
  },

  players() {
    const s = new Set();
    this.games.forEach((g) => g.players.forEach((p) => s.add(p)));
    return [...s].sort();
  },


  getSettings() { return lsGet(LS.settings, {}); },
  setSettings(s) { lsSet(LS.settings, s); },
  getToken() { return lsGet(LS.token, ''); },
  setToken(t) { lsSet(LS.token, t || null); },
  getApiKey() { return lsGet(LS.apiKey, ''); },
  setApiKey(k) { lsSet(LS.apiKey, k || null); },

  exportJSON() {
    return JSON.stringify({ version: 1, games: this.sortedGames() }, null, 2);
  },

  // ---------- GitHub 同步 ----------
  githubConfig() {
    const s = this.getSettings().github || {};
    const guess = guessRepo();
    return {
      owner: s.owner || guess.owner || '',
      repo: s.repo || guess.repo || '',
      branch: s.branch || 'main',
      path: s.path || 'data/games.json',
    };
  },

  canSync() {
    const c = this.githubConfig();
    return !!(this.getToken() && c.owner && c.repo);
  },

  async sync() {
    const cfg = this.githubConfig();
    const token = this.getToken();
    if (!token || !cfg.owner || !cfg.repo) throw new Error('请先在「设置」里填写 GitHub 仓库和 Token');
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, sha } = await ghRead(cfg, token);
      const merged = mergeGames(data.games || [], this.games, this.pending, this.deleted);
      merged.sort((a, b) => (a.date + (a.createdAt || '')).localeCompare(b.date + (b.createdAt || '')));
      const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), games: merged }, null, 2) + '\n';
      const ok = await ghWrite(cfg, token, body, sha, `更新麻将记录（${merged.length} 场）`);
      if (ok) {
        this.games = merged;
        this.pending.clear();
        this.deleted.clear();
        this.persist();
        return merged.length;
      }
    }
    throw new Error('同步冲突，请稍后重试');
  },

  async testGithub() {
    const cfg = this.githubConfig();
    const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}`, { headers: ghHeaders(this.getToken()) });
    if (!res.ok) throw new Error(`无法访问仓库（HTTP ${res.status}）`);
    const info = await res.json();
    if (info.permissions && !info.permissions.push) throw new Error('Token 没有该仓库的写入权限');
    return info.full_name;
  },
};

/** 以远端为基础，叠加本地待同步修改与删除 */
export function mergeGames(remoteGames, localGames, pending, deleted) {
  const map = new Map(remoteGames.map((g) => [g.id, g]));
  for (const g of localGames) {
    if (!pending.has(g.id)) continue;
    const r = map.get(g.id);
    if (!r || (g.updatedAt || '') >= (r.updatedAt || '')) map.set(g.id, g);
  }
  deleted.forEach((id) => map.delete(id));
  return [...map.values()];
}

function guessRepo() {
  const host = location.hostname;
  const m = host.match(/^([^.]+)\.github\.io$/i);
  if (!m) return {};
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: seg && !seg.includes('.') ? seg : `${m[1]}.github.io` };
}

function ghHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

function contentsUrl(cfg) {
  return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path.split('/').map(encodeURIComponent).join('/')}`;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function ghRead(cfg, token) {
  const url = `${contentsUrl(cfg)}?ref=${encodeURIComponent(cfg.branch)}&t=${Date.now()}`;
  const res = await fetch(url, { headers: ghHeaders(token), cache: 'no-store' });
  if (res.status === 404) return { data: { games: [] }, sha: null };
  if (!res.ok) throw new Error(`读取 GitHub 失败（HTTP ${res.status}）`);
  const meta = await res.json();
  let text;
  if (meta.content && meta.encoding === 'base64') {
    text = b64decode(meta.content);
  } else {
    // 文件超过 1MB 时需要用 raw 方式读取
    const raw = await fetch(url, { headers: { ...ghHeaders(token), Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
    text = await raw.text();
  }
  return { data: text.trim() ? JSON.parse(text) : { games: [] }, sha: meta.sha };
}

async function ghWrite(cfg, token, text, sha, message) {
  const body = { message, content: b64encode(text), branch: cfg.branch };
  if (sha) body.sha = sha;
  const res = await fetch(contentsUrl(cfg), { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) return false;
  if (!res.ok) throw new Error(`写入 GitHub 失败（HTTP ${res.status}）`);
  return true;
}
