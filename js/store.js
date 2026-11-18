// 数据存储：本地缓存 + 站点 data/games.json + GitHub API 同步

const LS = {
  db: 'mj.db',          // {games, chipDays, pending:[id], deleted:[id]}
  settings: 'mj.settings',
  token: 'mj.token',
  geminiKey: 'mj.geminiKey',
  oldAnthropicKey: 'mj.apikey', // 旧版本的 Anthropic Key，启动时清除
};

/** 每天一条 chips 记录，id 由日期决定，保证同一天只有一条 */
export const chipDayId = (date) => `chips-${date}`;

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
  chipDays: [], // [{id, date, players:[], chips:[], updatedAt}]
  pending: new Set(),
  deleted: new Set(),
  remoteLoaded: false,

  async init() {
    lsSet(LS.oldAnthropicKey, null);
    const local = lsGet(LS.db, { games: [], chipDays: [], pending: [], deleted: [] });
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
      this.chipDays = mergeGames(remote.chips || [], local.chipDays || [], this.pending, this.deleted);
    } else {
      this.games = local.games || [];
      this.chipDays = local.chipDays || [];
    }
    this.persist();
  },

  persist() {
    lsSet(LS.db, { games: this.games, chipDays: this.chipDays, pending: [...this.pending], deleted: [...this.deleted] });
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

  getChipDay(date) { return this.chipDays.find((d) => d.date === date); },

  saveChipDay(rec) {
    rec.id = chipDayId(rec.date);
    rec.updatedAt = new Date().toISOString();
    this.chipDays = this.chipDays.filter((d) => d.id !== rec.id).concat(rec);
    this.pending.add(rec.id);
    this.deleted.delete(rec.id);
    this.persist();
  },

  deleteChipDay(date) {
    const id = chipDayId(date);
    this.chipDays = this.chipDays.filter((d) => d.id !== id);
    this.pending.delete(id);
    this.deleted.add(id);
    this.persist();
  },

  /** 把某天的所有对局和当日 chips 移到另一天；目标日已有 chips 时按玩家相加。返回移动的场数 */
  moveDay(from, to) {
    if (!from || !to || from === to) return 0;
    const games = this.games.filter((g) => g.date === from);
    games.forEach((g) => this.saveGame({ ...g, date: to }));
    const src = this.getChipDay(from);
    if (src) {
      const merged = mergeChipDays(this.getChipDay(to), src);
      this.deleteChipDay(from);
      this.saveChipDay({ date: to, ...merged });
    }
    return games.length;
  },

  /** 返回导入的条数（对局 + chips 记录） */
  importGames(list, chipList = []) {
    let n = 0;
    for (const g of list) {
      if (!g || !g.id || g.players?.length !== 4 || g.scores?.length !== 4) continue;
      const cur = this.getGame(g.id);
      if (!cur || (g.updatedAt || '') > (cur.updatedAt || '')) { this.saveGame({ ...g }); n++; }
    }
    for (const d of chipList) {
      if (!d || !d.date || !Array.isArray(d.players) || !Array.isArray(d.chips)) continue;
      const cur = this.getChipDay(d.date);
      if (!cur || (d.updatedAt || '') > (cur.updatedAt || '')) {
        this.saveChipDay({ ...d });
        n++;
      }
    }
    return n;
  },

  sortedGames() {
    return this.games.slice().sort((a, b) => (a.date + (a.createdAt || '')).localeCompare(b.date + (b.createdAt || '')));
  },

  players() {
    const s = new Set();
    this.games.forEach((g) => g.players.forEach((p) => s.add(p)));
    this.chipDays.forEach((d) => d.players.forEach((p) => s.add(p)));
    return [...s].sort();
  },

  getSettings() { return lsGet(LS.settings, {}); },
  setSettings(s) { lsSet(LS.settings, s); },
  getToken() { return lsGet(LS.token, ''); },
  setToken(t) { lsSet(LS.token, t || null); },
  getApiKey() { return lsGet(LS.geminiKey, ''); },
  setApiKey(k) { lsSet(LS.geminiKey, k || null); },

  sortedChipDays() { return this.chipDays.slice().sort((a, b) => a.date.localeCompare(b.date)); },

  exportJSON() {
    return JSON.stringify({ version: 1, games: this.sortedGames(), chips: this.sortedChipDays() }, null, 2);
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
      const chips = mergeGames(data.chips || [], this.chipDays, this.pending, this.deleted);
      chips.sort((a, b) => a.date.localeCompare(b.date));
      const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), games: merged, chips }, null, 2) + '\n';
      const ok = await ghWrite(cfg, token, body, sha, `更新麻将记录（${merged.length} 场）`);
      if (ok) {
        this.games = merged;
        this.chipDays = chips;
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
    if (info.permissions && !info.permissions.push) throw new Error(`当前账号对 ${info.full_name} 没有写入权限`);
    // repo 信息里的 permissions 只反映账号权限；创建一个不被引用的 blob 来实际验证 Token 的 Contents 写权限
    // （不产生提交、不改动任何文件，GitHub 会自动清理）
    const w = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/git/blobs`, {
      method: 'POST',
      headers: ghHeaders(this.getToken()),
      body: JSON.stringify({ content: 'write-check', encoding: 'utf-8' }),
    });
    if (w.status === 401) throw new Error('GitHub Token 无效或已过期');
    if (!w.ok) throw new Error(writeDeniedMsg(cfg));
    return `${info.full_name}，可以写入`;
  },
};

/** 合并两条当日 chips 记录（按玩家相加），返回 {players, chips} */
export function mergeChipDays(a, b) {
  const players = [], chips = [];
  for (const rec of [a, b]) {
    rec?.players.forEach((name, i) => {
      const k = players.indexOf(name);
      if (k >= 0) chips[k] += rec.chips[i] || 0;
      else { players.push(name); chips.push(rec.chips[i] || 0); }
    });
  }
  return { players, chips };
}

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

function writeDeniedMsg(cfg) {
  return `Token 无法写入 ${cfg.owner}/${cfg.repo}（分支 ${cfg.branch}）。请确认：① 用户名/仓库名填写正确；`
    + `② Fine-grained token 的 Resource owner 是 ${cfg.owner}，且 Repository access 选中了 ${cfg.repo}；`
    + `③ 如果你是协作者而不是仓库主人，fine-grained token 不能写别人的个人仓库，请改用 Tokens (classic) 并勾选 public_repo`;
}

async function ghWrite(cfg, token, text, sha, message) {
  const body = { message, content: b64encode(text), branch: cfg.branch };
  if (sha) body.sha = sha;
  const res = await fetch(contentsUrl(cfg), { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) return false;
  if (res.status === 403 || res.status === 404) {
    const j = await res.json().catch(() => ({}));
    if (/protected branch|rule/i.test(j.message || '')) throw new Error(`分支 ${cfg.branch} 有保护规则，禁止直接写入：${j.message}`);
    throw new Error(writeDeniedMsg(cfg));
  }
  if (res.status === 401) throw new Error('GitHub Token 无效或已过期，请在「设置」中重新填写');
  if (!res.ok) throw new Error(`写入 GitHub 失败（HTTP ${res.status}）`);
  return true;
}
