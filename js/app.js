import { DEFAULT_RULES, totalOf, ranks, computePts, ptsToScores, gameResult, playerStats, headToHead, round1 } from './scoring.js';
import { store } from './store.js';

// ---------- 工具 ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtScore = (v) => Number(v).toLocaleString('en-US');
const fmtPt = (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}`;
const fmtSigned = (v) => `${v > 0 ? '+' : ''}${v}`;
const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const uid = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SEATS = ['东', '南', '西', '北'];

const rules = () => ({ ...DEFAULT_RULES, ...(store.getSettings().rules || {}) });
const rulesText = (r) => `${fmtScore(r.start)} 起 / ${fmtScore(r.returnPts)} 返 / 马 ${r.uma.map(fmtSigned).join(' ')}`;

const view = $('#view');
let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}
function bindView(h = {}) {
  view.onclick = h.click || null;
  view.oninput = h.input || null;
  view.onchange = h.change || null;
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const playerOptions = (sel, empty) =>
  `<option value="">${empty}</option>${store.players().map((p) => `<option ${p === sel ? 'selected' : ''}>${esc(p)}</option>`).join('')}`;

// ---------- 同步 ----------
function updateSyncBadge(text) {
  const b = $('#sync-badge');
  const n = store.dirtyCount;
  b.classList.toggle('dirty', n > 0);
  b.hidden = false;
  if (text) b.textContent = text;
  else if (n > 0) b.textContent = store.canSync() ? `未同步 ${n} · 点击同步` : `仅本地 ${n}`;
  else if (store.canSync()) b.textContent = '已同步';
  else b.hidden = true;
}
async function doSync({ quiet = false } = {}) {
  if (!store.canSync()) {
    if (!quiet) { toast('请先在设置中配置 GitHub'); location.hash = '#/settings'; }
    return;
  }
  updateSyncBadge('同步中…');
  try {
    const n = await store.sync();
    toast(`已同步到 GitHub（共 ${n} 场）`);
    if (!location.hash.startsWith('#/add')) route();
  } catch (e) { toast(e.message, 'error'); }
  updateSyncBadge();
}
function afterDataChange() {
  updateSyncBadge();
  if (store.canSync()) doSync({ quiet: true });
}
$('#sync-badge').onclick = () => (store.canSync() ? doSync() : (location.hash = '#/settings'));

// ---------- 路由 ----------
function parseHash() {
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { page: path || 'add', q: Object.fromEntries(new URLSearchParams(qs)) };
}
function route() {
  const { page, q } = parseHash();
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === page));
  if (page === 'list') renderList(q);
  else if (page === 'stats') renderStats(q);
  else if (page === 'settings') renderSettings();
  else renderAdd(q);
  updateSyncBadge();
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });

// ========== 录入 ==========
let form = null;
let photo = null; // {url, file, loading, error, result, used:Set}

function blankForm() {
  const last = store.getSettings().lastPlayers || ['', '', '', ''];
  return { id: null, date: today(), note: '', kind: 'score', players: last.slice(0, 4), values: ['', '', '', ''], chips: ['', '', '', ''] };
}

/** 解析表单 → {scores, pts, diff}；允许留空一人自动补齐 */
function computeForm(f, r) {
  const vals = f.values.map((v) => (String(v).trim() === '' ? null : Number(String(v).replace(/[▲△]/, '-').replace(/,/g, ''))));
  if (vals.some((v) => Number.isNaN(v))) return null;
  const blanks = vals.filter((v) => v === null).length;
  let filled = -1;
  if (blanks === 1) {
    filled = vals.indexOf(null);
    const sum = vals.reduce((a, v) => a + (v || 0), 0);
    vals[filled] = f.kind === 'score' ? totalOf(r) - sum : round1(-sum);
  } else if (blanks > 1) return null;
  const scores = f.kind === 'score' ? vals : ptsToScores(vals, r);
  return { scores, pts: computePts(scores, r), diff: scores.reduce((a, v) => a + v, 0) - totalOf(r), filled, filledValue: vals[filled] };
}

function fillFromGame(g) {
  form.kind = g.kind;
  g.players.slice(0, 4).forEach((p, i) => {
    if (p.name) form.players[i] = p.name;
    form.values[i] = String(p.value);
  });
}

function renderAdd(q) {
  const editingId = q.id || null;
  if (!form || form.id !== editingId) {
    const g = editingId && store.getGame(editingId);
    form = g
      ? { id: g.id, date: g.date, note: g.note || '', kind: 'score', players: g.players.slice(), values: g.scores.map(String), chips: (g.chips || [0, 0, 0, 0]).map((c) => (c ? String(c) : '')) }
      : blankForm();
  }
  const f = form, r = rules();
  const known = store.players();
  const apiKey = store.getApiKey();

  view.innerHTML = `
  <div class="card">
    <div class="row" style="margin-bottom:12px">
      <h2 style="margin:0">${f.id ? '编辑对局' : '录入对局'}</h2>
      <span class="spacer"></span>
      <label class="btn">📷 上传记分照片<input type="file" id="photo-input" accept="image/*" hidden></label>
    </div>
    <div class="grid-2">
      <label class="field">日期<input type="date" id="f-date" value="${esc(f.date)}"></label>
      <label class="field">备注（可选）<input id="f-note" value="${esc(f.note)}" placeholder="例如：周五友人场"></label>
    </div>
    <div class="row" style="margin:14px 0 8px">
      <span class="small muted">输入的是：</span>
      <div class="seg">${[['score', '终局点数'], ['pt', '马点 pt']].map(([k, t]) => `<button data-kind="${k}" class="${f.kind === k ? 'on' : ''}">${t}</button>`).join('')}</div>
      <span class="small muted">${rulesText(r)}</span>
    </div>
    <datalist id="known-players">${known.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    <div class="entry-head small muted"><span></span><span>玩家</span><span>${f.kind === 'score' ? '终局点数' : '马点'}</span><span>chips</span></div>
    ${[0, 1, 2, 3].map((i) => `
      <div class="entry-row" id="row-${i}">
        <span class="rank" id="rank-${i}">${SEATS[i]}</span>
        <input data-player="${i}" list="known-players" value="${esc(f.players[i])}" placeholder="${SEATS[i]}家" autocomplete="off">
        <input data-value="${i}" class="num" inputmode="decimal" value="${esc(f.values[i])}">
        <input data-chips="${i}" class="num" inputmode="numeric" value="${esc(f.chips[i])}" placeholder="chips">
        <div class="entry-calc small" id="calc-${i}"></div>
      </div>`).join('')}
    <div id="sum-status" class="sum-status"></div>
    <div class="row" style="margin-top:12px">
      <button class="primary" data-act="save" id="save-btn">保存</button>
      ${f.id ? '<button data-act="cancel-edit">取消编辑</button>' : '<button data-act="clear">清空</button>'}
    </div>
  </div>
  ${photo ? `
  <div class="card">
    <div class="photo-grid">
      <img src="${photo.url}" alt="记分照片" class="photo">
      <div>
        <div class="row">
        ${apiKey
          ? `<button class="primary" data-act="recognize" ${photo.loading ? 'disabled' : ''}>${photo.loading ? '识别中…（约 10–30 秒）' : photo.result ? '重新识别' : '用 Claude 识别'}</button>`
          : '<p class="small muted" style="margin:0">在「<a href="#/settings">设置</a>」填写 Anthropic API Key 后可自动识别；也可以对照照片手动录入。</p>'}
          <button class="ghost" data-act="close-photo">关闭照片</button>
        </div>
        ${photo.error ? `<div class="notice" style="margin-top:10px">${esc(photo.error)}</div>` : ''}
        ${photo.result ? renderRecognized(photo.result) : ''}
      </div>
    </div>
  </div>` : ''}`;
  updatePreview();

  bindView({
    click(e) {
      const b = e.target.closest('button');
      if (!b) return;
      const ds = b.dataset;
      if (ds.kind) { form.kind = ds.kind; return renderAdd(q); }
      if (ds.act === 'save') return saveForm();
      if (ds.act === 'clear') { form = blankForm(); return renderAdd(q); }
      if (ds.act === 'cancel-edit') { form = null; location.hash = '#/list'; return; }
      if (ds.act === 'close-photo') { URL.revokeObjectURL(photo.url); photo = null; return renderAdd(q); }
      if (ds.act === 'recognize') return runRecognize(q);
      if (ds.fillGame != null) {
        fillFromGame(photo.result.games[Number(ds.fillGame)]);
        photo.used.add(Number(ds.fillGame));
        return renderAdd(q);
      }
      if (ds.act === 'fill-chips') {
        for (const c of photo.result.chips) {
          const i = form.players.findIndex((p) => p.trim() === c.name.trim());
          if (i >= 0) form.chips[i] = String(c.count);
        }
        return renderAdd(q);
      }
    },
    input(e) {
      const t = e.target, ds = t.dataset;
      if (t.id === 'f-date') form.date = t.value;
      else if (t.id === 'f-note') form.note = t.value;
      else if (ds.player) form.players[ds.player] = t.value;
      else if (ds.value) form.values[ds.value] = t.value;
      else if (ds.chips) form.chips[ds.chips] = t.value;
      updatePreview();
    },
    change(e) {
      if (e.target.id !== 'photo-input') return;
      const file = e.target.files[0];
      if (!file) return;
      if (photo) URL.revokeObjectURL(photo.url);
      photo = { file, url: URL.createObjectURL(file), used: new Set() };
      renderAdd(q);
      if (store.getApiKey()) runRecognize(q);
    },
  });
}

function renderRecognized(res) {
  const games = res.games || [];
  return `
    <div class="field-label">识别到 ${games.length} 场，点击填入上方表单，核对后保存：</div>
    ${games.map((g, k) => `
      <button class="recog ${photo.used.has(k) ? 'used' : ''}" data-fill-game="${k}">
        <span class="tag">#${k + 1} ${g.kind === 'pt' ? '马点' : '点数'}</span>
        ${g.players.map((p) => `<span>${esc(p.name || '?')} <b class="num">${g.kind === 'pt' ? fmtPt(p.value) : fmtScore(p.value)}</b></span>`).join('')}
        ${photo.used.has(k) ? '<span class="small muted">已填入</span>' : ''}
      </button>`).join('')}
    ${res.chips?.length ? `<button data-act="fill-chips" style="margin-top:6px">填入 chips：${res.chips.map((c) => `${esc(c.name)} ${fmtSigned(c.count)}`).join('，')}</button>` : ''}
    ${res.notes ? `<p class="small muted">识别备注：${esc(res.notes)}</p>` : ''}`;
}

async function runRecognize(q) {
  if (!photo || photo.loading) return;
  photo.loading = true;
  photo.error = null;
  renderAdd(q);
  try {
    const { recognizeSheet } = await import('./recognize.js');
    photo.result = await recognizeSheet(photo.file, store.getApiKey(), store.players());
    if (photo.result.games?.length === 1) { fillFromGame(photo.result.games[0]); photo.used.add(0); }
  } catch (err) {
    photo.error = err.message || String(err);
  }
  photo.loading = false;
  if (parseHash().page === 'add') renderAdd(parseHash().q);
}

function updatePreview() {
  const r = rules();
  const c = computeForm(form, r);
  const rk = c ? ranks(c.scores) : null;
  const ph = form.kind === 'score' ? '例 41000' : '例 +60.0';
  for (let i = 0; i < 4; i++) {
    const row = $(`#row-${i}`);
    row.className = `entry-row ${rk ? `r${rk[i] + 1}` : ''}`;
    $(`#rank-${i}`).textContent = rk ? `${rk[i] + 1}位` : SEATS[i];
    row.querySelector('[data-value]').placeholder = c && c.filled === i ? `自动 ${form.kind === 'score' ? c.filledValue : fmtPt(c.filledValue)}` : ph;
    $(`#calc-${i}`).innerHTML = c
      ? (form.kind === 'score' ? `<b class="${sign(c.pts[i])}">${fmtPt(c.pts[i])}</b>` : `${fmtScore(c.scores[i])} 点`)
      : '';
  }
  const st = $('#sum-status');
  const chipSum = form.chips.reduce((a, v) => a + (Number(v) || 0), 0);
  const chipNote = chipSum ? `<span class="muted"> · chips 合计 ${fmtSigned(chipSum)}</span>` : '';
  let ok = false;
  if (!c) st.innerHTML = '<span class="muted">填入四家数值（可留空一家自动补齐）</span>';
  else if (c.diff === 0) { ok = true; st.innerHTML = `<span class="ok">✓ 合计 ${fmtScore(totalOf(r))}</span>${chipNote}`; }
  else st.innerHTML = `<span class="bad">✗ 合计 ${fmtScore(totalOf(r) + c.diff)}，与 ${fmtScore(totalOf(r))} 相差 ${fmtSigned(c.diff)}</span>${chipNote}`;
  $('#save-btn').disabled = !ok;
}

function saveForm() {
  const r = rules();
  const c = computeForm(form, r);
  if (!c || c.diff !== 0) return toast(`四家合计必须为 ${fmtScore(totalOf(r))}`, 'error');
  const players = form.players.map((p) => p.trim());
  if (players.some((p) => !p)) return toast('请填写四位玩家名', 'error');
  if (new Set(players).size !== 4) return toast('玩家名不能重复', 'error');
  const old = form.id && store.getGame(form.id);
  store.saveGame({
    id: form.id || uid(),
    date: form.date || today(),
    createdAt: old?.createdAt || new Date().toISOString(),
    rules: old?.rules || r,
    players,
    scores: c.scores,
    chips: form.chips.map((v) => Math.round(Number(v) || 0)),
    note: form.note.trim(),
  });
  const s = store.getSettings();
  s.lastPlayers = players;
  store.setSettings(s);
  const wasEdit = !!form.id;
  form = null;
  afterDataChange();
  toast(wasEdit ? '已更新' : '已保存');
  if (wasEdit) location.hash = '#/list';
  else renderAdd({});
}

// ========== 记录列表 ==========
function resultRows(g) {
  return gameResult(g).sort((a, b) => a.rank - b.rank).map((r) => `
    <div class="res r${r.rank}">
      <span class="rank">${r.rank}位</span>
      <span class="n">${esc(r.name)}</span>
      <span class="num s">${fmtScore(r.score)}</span>
      <b class="num p">${fmtPt(r.pt)}</b>
      <span class="num c">${r.chips ? `${fmtSigned(r.chips)}枚` : ''}</span>
    </div>`).join('');
}

function renderList(q) {
  const p = q.p || '', o = q.q || '';
  const games = store.sortedGames().reverse().filter((g) => (!p || g.players.includes(p)) && (!o || g.players.includes(o)));
  let html = `
  <div class="filters">
    <label class="field">玩家<select data-f="p">${playerOptions(p, '全部')}</select></label>
    <label class="field">同桌<select data-f="q">${playerOptions(o, '不限')}</select></label>
    <span class="spacer"></span>
    <span class="muted small">${games.length} 场</span>
  </div>`;
  if (!games.length) html += '<div class="card empty">没有记录。去「录入」添加第一场吧。</div>';
  let month = '';
  for (const g of games) {
    const m = g.date.slice(0, 7);
    if (m !== month) { month = m; html += `<div class="month-head">${m.replace('-', ' 年 ')} 月</div>`; }
    html += `
    <div class="card game">
      <div class="game-meta">
        <b>${esc(g.date)}</b>${g.note ? `<span>${esc(g.note)}</span>` : ''}
        ${store.pending.has(g.id) ? '<span class="tag">未同步</span>' : ''}
        <span class="spacer"></span>
        <a href="#/add?id=${encodeURIComponent(g.id)}" class="small">编辑</a>
        <button class="link danger small" data-del="${esc(g.id)}">删除</button>
      </div>
      <div class="results">${resultRows(g)}</div>
    </div>`;
  }
  view.innerHTML = html;
  bindView({
    click(e) {
      const id = e.target.closest('[data-del]')?.dataset.del;
      if (!id || !confirm('确定删除这场对局？')) return;
      store.deleteGame(id);
      afterDataChange();
      renderList(q);
      toast('已删除');
    },
    change(e) {
      const f = e.target.dataset.f;
      if (!f) return;
      const nq = { ...q, [f]: e.target.value };
      Object.keys(nq).forEach((k) => !nq[k] && delete nq[k]);
      location.hash = `#/list${Object.keys(nq).length ? `?${new URLSearchParams(nq)}` : ''}`;
    },
  });
}

// ========== 统计 ==========
function renderStats(q) {
  const me = q.p || '';
  const games = store.sortedGames();
  let html = `
  <div class="filters">
    <label class="field">选择玩家<select data-f="p">${playerOptions(me, '全部玩家')}</select></label>
  </div>`;

  const s = me && playerStats(games).find((x) => x.name === me);
  if (!games.length) html += '<div class="card empty">还没有记录。</div>';
  else if (!s) {
    const rows = playerStats(games).sort((a, b) => b.pt - a.pt);
    html += `
    <div class="card"><h3>排行榜</h3>
      <div class="table-scroll"><table>
        <thead><tr><th>玩家</th><th>场数</th><th>总pt</th><th>平均pt</th><th>平均顺位</th><th>1位</th><th>2位</th><th>3位</th><th>4位</th><th>chips</th></tr></thead>
        <tbody>${rows.map((x) => `<tr>
          <td><a href="#/stats?p=${encodeURIComponent(x.name)}"><b>${esc(x.name)}</b></a></td>
          <td>${x.games}</td><td class="${sign(x.pt)}"><b>${fmtPt(x.pt)}</b></td><td class="${sign(x.avgPt)}">${fmtPt(x.avgPt)}</td>
          <td>${x.avgRank.toFixed(2)}</td>
          ${x.rankCount.map((c, i) => `<td><span class="cell-r r${i + 1}">${pct(c / x.games)}</span></td>`).join('')}
          <td class="${sign(x.chips)}">${fmtSigned(x.chips)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">点击玩家名查看与其他人的对局胜率。</p>
    </div>`;
  } else {
    const h2h = headToHead(games, me).sort((a, b) => b.games - a.games || b.winRate - a.winRate);
    html += `
    <div class="kpis">
      <div class="kpi"><div class="k">场数</div><div class="v">${s.games}</div></div>
      <div class="kpi"><div class="k">总 pt</div><div class="v ${sign(s.pt)}">${fmtPt(s.pt)}</div></div>
      <div class="kpi"><div class="k">平均顺位</div><div class="v">${s.avgRank.toFixed(2)}</div></div>
      <div class="kpi"><div class="k">chips</div><div class="v ${sign(s.chips)}">${fmtSigned(s.chips)}</div></div>
    </div>
    <div class="card"><h3>顺位分布</h3>
      <div class="rank-bar">${s.rankCount.map((c, i) => (c ? `<div class="r${i + 1}" style="flex:${c}">${i + 1}位 ${c}场</div>` : '')).join('')}</div>
    </div>
    <div class="card"><h3>与对手的胜率</h3>
      <p class="muted small">同桌时 ${esc(me)} 的名次比对手高记为胜。点击一行查看两人同桌的对局。</p>
      <div class="table-scroll"><table>
        <thead><tr><th>对手</th><th>同桌</th><th>胜</th><th>负</th><th>胜率</th><th>${esc(me)} pt</th><th>对手 pt</th></tr></thead>
        <tbody>${h2h.map((h) => `<tr class="clickable" data-vs="${esc(h.name)}">
          <td><b>${esc(h.name)}</b></td><td>${h.games}</td><td>${h.wins}</td><td>${h.losses}</td>
          <td><span class="winrate"><span style="width:${(h.winRate * 100).toFixed(0)}%"></span></span><b>${pct(h.winRate)}</b></td>
          <td class="${sign(h.myPt)}">${fmtPt(h.myPt)}</td><td class="${sign(h.oppPt)}">${fmtPt(h.oppPt)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  }
  view.innerHTML = html;
  bindView({
    change(e) {
      if (e.target.dataset.f === 'p') location.hash = e.target.value ? `#/stats?p=${encodeURIComponent(e.target.value)}` : '#/stats';
    },
    click(e) {
      const vs = e.target.closest('[data-vs]')?.dataset.vs;
      if (vs) location.hash = `#/list?${new URLSearchParams({ p: me, q: vs })}`;
    },
  });
}

// ========== 设置 ==========
function renderSettings() {
  const r = rules();
  const cfg = store.githubConfig();
  const token = store.getToken();
  const apiKey = store.getApiKey();
  view.innerHTML = `
  <div class="card">
    <h2>计分规则</h2>
    <p class="muted small">新录入的对局使用这里的规则；已保存的对局保留录入时的规则。</p>
    <div class="grid-4">
      <label class="field">起始点<input type="number" step="1000" id="r-start" value="${r.start}"></label>
      <label class="field">返点<input type="number" step="1000" id="r-return" value="${r.returnPts}"></label>
      ${r.uma.map((u, i) => `<label class="field">${i + 1}位马<input type="number" id="r-uma${i}" value="${u}"></label>`).join('')}
    </div>
    <p class="small muted">例：1 位 50000 点 → (50000 − ${fmtScore(r.returnPts)}) / 1000 ${fmtSigned(r.uma[0])} + 头名赏 ${((r.returnPts - r.start) * 4) / 1000} = <b>${fmtPt(computePts([50000, 30000, 15000, 5000], r)[0])}</b></p>
    <button class="primary" data-act="save-rules">保存规则</button>
  </div>
  <div class="card">
    <h2>照片识别（Claude）</h2>
    <p class="muted small">在 <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> 创建 API Key（按量付费，识别一张约几分钱）。Key 只保存在当前浏览器，图片从浏览器直接发给 Anthropic。</p>
    <label class="field">Anthropic API Key<input type="password" id="api-key" value="${esc(apiKey)}" placeholder="sk-ant-…" autocomplete="off"></label>
    <div class="row" style="margin-top:10px"><button class="primary" data-act="save-key">保存</button>
      <button class="ghost danger" data-act="clear-key" ${apiKey ? '' : 'disabled'}>清除</button></div>
  </div>
  <div class="card">
    <h2>GitHub 同步</h2>
    <p class="muted small">记录保存在仓库的 <code>${esc(cfg.path)}</code>，GitHub Pages 上任何人可浏览；只有填了 Token 的浏览器可以写入。</p>
    <div class="grid-2">
      <label class="field">用户名（owner）<input id="g-owner" value="${esc(cfg.owner)}"></label>
      <label class="field">仓库名（repo）<input id="g-repo" value="${esc(cfg.repo)}"></label>
      <label class="field">分支<input id="g-branch" value="${esc(cfg.branch)}"></label>
      <label class="field">数据文件<input id="g-path" value="${esc(cfg.path)}"></label>
    </div>
    <label class="field" style="margin-top:10px">Personal Access Token<input id="g-token" type="password" value="${esc(token)}" placeholder="github_pat_…" autocomplete="off"></label>
    <details><summary>如何获取 Token？</summary>
      <ol class="small muted">
        <li>GitHub → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token</li>
        <li>Repository access 选 <b>Only select repositories</b>，只选这个仓库</li>
        <li>Repository permissions → <b>Contents: Read and write</b></li>
      </ol>
    </details>
    <div class="row" style="margin-top:12px">
      <button class="primary" data-act="save-gh">保存</button>
      <button data-act="test-gh">测试连接</button>
      <button data-act="sync">立即同步</button>
    </div>
  </div>
  <div class="card">
    <h2>导入 / 导出</h2>
    <p class="muted small">CSV 列：date, note, name1, score1, chips1, …, name4, score4, chips4</p>
    <div class="row">
      <button data-act="export-json">导出 JSON</button>
      <button data-act="export-csv">导出 CSV</button>
      <label class="btn">导入文件<input type="file" id="import-file" accept=".json,.csv" hidden></label>
    </div>
  </div>`;

  const saveGh = () => {
    const s = store.getSettings();
    s.github = { owner: $('#g-owner').value.trim(), repo: $('#g-repo').value.trim(), branch: $('#g-branch').value.trim() || 'main', path: $('#g-path').value.trim() || 'data/games.json' };
    store.setSettings(s);
    store.setToken($('#g-token').value.trim());
    updateSyncBadge();
  };

  bindView({
    async click(e) {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      if (act === 'save-rules') {
        const nr = { start: Number($('#r-start').value), returnPts: Number($('#r-return').value), uma: [0, 1, 2, 3].map((i) => Number($(`#r-uma${i}`).value)) };
        if ([nr.start, nr.returnPts, ...nr.uma].some((v) => Number.isNaN(v))) return toast('请输入数字', 'error');
        const s = store.getSettings(); s.rules = nr; store.setSettings(s);
        toast('规则已保存'); renderSettings();
      } else if (act === 'save-key') { store.setApiKey($('#api-key').value.trim()); toast('已保存'); renderSettings(); }
      else if (act === 'clear-key') { store.setApiKey(''); toast('已清除'); renderSettings(); }
      else if (act === 'save-gh') { saveGh(); toast('已保存'); }
      else if (act === 'test-gh') { saveGh(); try { toast(`连接成功：${await store.testGithub()}`); } catch (err) { toast(err.message, 'error'); } }
      else if (act === 'sync') { saveGh(); await doSync(); }
      else if (act === 'export-json') download(`mahjong-${today()}.json`, store.exportJSON(), 'application/json');
      else if (act === 'export-csv') download(`mahjong-${today()}.csv`, exportCSV(), 'text/csv');
    },
    async change(e) {
      if (e.target.id !== 'import-file') return;
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const list = file.name.toLowerCase().endsWith('.csv') ? importCSV(text) : (() => { const j = JSON.parse(text); return Array.isArray(j) ? j : j.games || []; })();
        const k = store.importGames(list);
        toast(`导入 ${k} 场`);
        if (k) afterDataChange();
      } catch (err) { toast(`导入失败：${err.message}`, 'error'); }
    },
  });
}

// ---------- CSV ----------
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function exportCSV() {
  const head = ['date', 'note'];
  for (let i = 1; i <= 4; i++) head.push(`name${i}`, `score${i}`, `chips${i}`, `rank${i}`, `pt${i}`);
  const lines = [head.join(',')];
  for (const g of store.sortedGames()) {
    const row = [g.date, g.note || ''];
    gameResult(g).forEach((r) => row.push(r.name, r.score, r.chips, r.rank, r.pt));
    lines.push(row.map(csvCell).join(','));
  }
  return '﻿' + lines.join('\n');
}
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function importCSV(text) {
  const [head, ...rows] = parseCSV(text);
  const idx = (k) => head.findIndex((h) => h.trim().toLowerCase() === k);
  if (idx('date') < 0 || idx('name1') < 0 || idx('score1') < 0) throw new Error('CSV 需要 date、name1、score1… 列');
  const r = rules();
  return rows.map((row, k) => {
    const players = [], scores = [], chips = [];
    for (let i = 1; i <= 4; i++) {
      players.push((row[idx(`name${i}`)] || '').trim());
      scores.push(Number(row[idx(`score${i}`)]));
      chips.push(idx(`chips${i}`) >= 0 ? Number(row[idx(`chips${i}`)]) || 0 : 0);
    }
    if (players.some((p) => !p) || scores.some((v) => Number.isNaN(v))) return null;
    const date = row[idx('date')].trim().replace(/\//g, '-');
    return { id: `csv-${date}-${players.join('-')}-${scores.join('_')}`, date, createdAt: new Date(Date.now() + k).toISOString(), rules: r, players, scores, chips, note: idx('note') >= 0 ? (row[idx('note')] || '').trim() : '' };
  }).filter(Boolean);
}

// ---------- 启动 ----------
store.init().then(route);
