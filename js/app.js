import { DEFAULT_RULES, totalOf, ranks, computePts, ptsToScores, gameResult, playerStats, headToHead, round1, verifyRecognized, recognizedToGame, renameRecognized } from './scoring.js?v=202611212319';
import { store } from './store.js?v=202611212319';
import { DEFAULT_GEMINI_MODEL, recognizeSheet } from './recognize.js?v=202611212319';

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

// 版本号取自 index.html 引用 app.js 时的 ?v=…，和缓存版本号是同一个
const APP_VERSION = new URL(import.meta.url).searchParams.get('v') || '开发版';
$('#app-version').textContent = `版本 ${APP_VERSION}`;
let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'error' ? 8000 : 3000);
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
/** 解析数字输入：支持 ▲ △ − － 作为负号，忽略逗号；空 → null，非法 → NaN */
function toNum(v) {
  const t = String(v ?? '').trim().replace(/^[▲△−－ー]/, '-').replace(/[,，\s]/g, '');
  return t === '' ? null : Number(t);
}
function toggleSign(v) {
  const t = String(v ?? '').trim();
  if (/^[-▲△−－ー]/.test(t)) return t.slice(1);
  if (t.startsWith('+')) return `-${t.slice(1)}`;
  return `-${t}`;
}
/** 数字输入框 + 「±」按钮（手机数字键盘通常没有负号） */
const numField = (attrs, value, placeholder = '') =>
  `<span class="num-wrap"><input ${attrs} class="num" inputmode="decimal" autocomplete="off" value="${esc(value)}" placeholder="${esc(placeholder)}"><button type="button" class="neg-btn" data-neg tabindex="-1" title="切换正负" aria-label="切换正负">±</button></span>`;
view.addEventListener('click', (e) => {
  const b = e.target.closest('[data-neg]');
  if (!b) return;
  const input = b.parentElement.querySelector('input');
  input.value = toggleSign(input.value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

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
  return { page: path || 'stats', q: Object.fromEntries(new URLSearchParams(qs)) };
}
function route() {
  const { page, q } = parseHash();
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === page));
  if (page === 'list') renderList(q);
  else if (page === 'rank') renderRank(q);
  else if (page === 'add') renderAdd(q);
  else if (page === 'settings') renderSettings();
  else renderStats(q); // 默认（及未知地址）显示统计
  updateSyncBadge();
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });

// ========== 录入 ==========
let form = null;
let photo = null; // {url, file, loading, error, result, used:Set, saved:Set, saveChips, names:[]}
let chipForm = null; // 当日 chips：{date, values:{name: string}, extra:[name]}

function blankForm() {
  const last = store.getSettings().lastPlayers || ['', '', '', ''];
  return { id: null, date: today(), note: '', kind: 'score', players: last.slice(0, 4), values: ['', '', '', ''] };
}

/** 解析表单 → {scores, pts, diff}；允许留空一人自动补齐 */
function computeForm(f, r) {
  const vals = f.values.map(toNum);
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
      ? { id: g.id, date: g.date, note: g.note || '', kind: 'score', players: g.players.slice(), values: g.scores.map(String) }
      : blankForm();
  }
  // 从记录页「编辑当日 chips」跳转过来
  let scrollToChips = false;
  if (q.date && !form.id && form.fromQuery !== q.date) { form.date = q.date; form.fromQuery = q.date; scrollToChips = true; }
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
    <div class="entry-head small muted"><span></span><span>玩家</span><span>${f.kind === 'score' ? '终局点数' : '马点'}</span><span></span></div>
    ${[0, 1, 2, 3].map((i) => `
      <div class="entry-row" id="row-${i}">
        <span class="rank" id="rank-${i}">${SEATS[i]}</span>
        <input data-player="${i}" list="known-players" value="${esc(f.players[i])}" placeholder="${SEATS[i]}家" autocomplete="off">
        ${numField(`data-value="${i}"`, f.values[i])}
        <div class="entry-calc small" id="calc-${i}"></div>
      </div>`).join('')}
    <div id="sum-status" class="sum-status"></div>
    <div class="row" style="margin-top:12px">
      <button class="primary" data-act="save" id="save-btn">保存</button>
      ${f.id ? '<button data-act="cancel-edit">取消编辑</button>' : '<button data-act="clear">清空</button>'}
    </div>
  </div>
  <div class="card" id="chip-card"></div>
  ${photo ? `
  <div class="card">
    <div class="photo-grid">
      <img src="${photo.url}" alt="记分照片" class="photo">
      <div>
        <div class="row">
        ${apiKey
          ? `<button class="primary" data-act="recognize" ${photo.loading ? 'disabled' : ''}>${photo.loading ? '识别中…（约 10–30 秒）' : photo.result ? '重新识别' : '用 Gemini 识别'}</button>`
          : '<p class="small muted" style="margin:0">在「<a href="#/settings">设置</a>」填写 Gemini API Key 后可自动识别；也可以对照照片手动录入。</p>'}
          <button class="ghost" data-act="close-photo">关闭照片</button>
        </div>
        ${photo.error ? `<div class="notice" style="margin-top:10px">${esc(photo.error)}</div>` : ''}
        ${photo.result ? renderRecognized(photo.result) : ''}
      </div>
    </div>
  </div>` : ''}`;
  updatePreview();
  renderChipCard();
  if (scrollToChips) $('#chip-card').scrollIntoView({ block: 'start' });

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
        ensureChipForm();
        for (const c of photo.result.chips) {
          const name = c.name.trim();
          if (!name) continue;
          chipForm.values[name] = String(c.count);
          if (!chipForm.extra.includes(name)) chipForm.extra.push(name);
        }
        renderChipCard();
        $('#chip-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
        return toast(`已填入 ${form.date} 的 chips，核对后点「保存 chips」`);
      }
      if (ds.act === 'apply-rename') return applyRename(q);
      if (ds.act === 'save-all') return saveAllRecognized(q);
      if (ds.act === 'save-chips') return saveChips();
      if (ds.act === 'delete-chips') {
        if (!confirm(`删除 ${form.date} 的 chips 记录？`)) return;
        store.deleteChipDay(form.date);
        chipForm = null;
        afterDataChange();
        renderChipCard();
        return toast('已删除');
      }
      if (ds.act === 'add-chip-player') return addChipPlayer();
    },
    input(e) {
      const t = e.target, ds = t.dataset;
      if (t.id === 'f-date') { form.date = t.value; renderChipCard(); }
      else if (t.id === 'f-note') form.note = t.value;
      else if (ds.player) form.players[ds.player] = t.value;
      else if (ds.value) form.values[ds.value] = t.value;
      else if (ds.chipIdx) { chipForm.values[chipForm.names[ds.chipIdx]] = t.value; return updateChipStatus(); }
      else return;
      updatePreview();
    },
    change(e) {
      if (e.target.id === 'chip-add') return addChipPlayer();
      if (e.target.id === 'save-chips-too') { photo.saveChips = e.target.checked; return; }
      if (e.target.id !== 'photo-input') return;
      const file = e.target.files[0];
      if (!file) return;
      if (photo) URL.revokeObjectURL(photo.url);
      photo = { file, url: URL.createObjectURL(file), used: new Set(), saved: new Set(), saveChips: true };
      renderAdd(q);
      if (store.getApiKey()) runRecognize(q);
    },
  });
}

function renderRecognized(res) {
  const games = res.games || [];
  const v = verifyRecognized(res, rules());
  const fmtVal = (kind, x) => (kind === 'pt' ? fmtPt(x) : fmtScore(x));
  const fmtNum = (x) => (Number.isInteger(x) ? fmtSigned(x) : fmtPt(x));
  const badCount = v.games.filter((g) => !g.ok).length + v.totals.filter((t) => !t.ok).length;
  // 所有识别到的名字（按出现顺序），用于批量改名
  const known = new Set(store.players());
  const names = [];
  const addName = (n) => { const t = String(n ?? '').trim(); if (t && !names.includes(t)) names.push(t); };
  [res.chips, ...games.map((g) => g.players), res.totals, res.money].forEach((arr) => (arr || []).forEach((x) => addName(x.name)));
  photo.names = names;
  const unknown = names.filter((n) => !known.has(n));
  const savable = games.filter((g, k) => !photo.saved.has(k) && !recognizedToGame(g, rules()).error).length;
  const date = form.date || today();
  return `
    <details class="rename" ${unknown.length && known.size ? 'open' : ''}>
      <summary class="field-label">玩家名（${names.length} 人${unknown.length && known.size ? `，${unknown.length} 个新名字` : ''}）· 识别错了可以批量改名</summary>
      <div class="rename-grid">${names.map((n, i) => `
        <label class="rename-row"><span class="n">${esc(n)}${known.has(n) || !known.size ? '' : ' <span class="tag">新名字</span>'}</span>
          <span class="muted">→</span><input data-rename="${i}" list="known-players" placeholder="${esc(n)}" autocomplete="off"></label>`).join('')}
      </div>
      <button data-act="apply-rename" style="margin-top:6px">应用改名</button>
      <span class="small muted">留空表示不改；改成同一个名字可以合并</span>
    </details>
    ${res.chips?.length ? `
      <div class="field-label">chips（第一行名字旁的数字）：</div>
      <button data-act="fill-chips" class="recog">${res.chips.map((c) => `<span>${esc(c.name)} <b class="num">${fmtSigned(c.count)}</b></span>`).join('')}<span class="small muted">点击填入当日 chips</span></button>` : ''}
    <div class="field-label" style="margin-top:10px">识别到 ${games.length} 场。可以一次全部保存，也可以点某一场填入上方表单单独修改：</div>
    <div class="row save-all">
      <button class="primary" data-act="save-all" ${savable ? '' : 'disabled'}>全部保存（${savable} 场 · ${esc(date)}）</button>
      ${res.chips?.length ? `<label class="small"><input type="checkbox" id="save-chips-too" ${photo.saveChips ? 'checked' : ''}> 同时保存当日 chips</label>` : ''}
    </div>
    ${games.map((g, k) => `
      <button class="recog ${photo.used.has(k) || photo.saved.has(k) ? 'used' : ''} ${v.games[k].ok ? '' : 'warn'}" data-fill-game="${k}" ${photo.saved.has(k) ? 'disabled' : ''}>
        <span class="tag">#${k + 1} ${g.kind === 'pt' ? '马点' : '点数'}</span>
        ${g.players.map((p) => `<span>${esc(p.name || '?')} <b class="num">${fmtVal(g.kind, p.value)}</b></span>`).join('')}
        ${v.games[k].ok ? '' : `<span class="small bad">⚠ ${g.players.length !== 4 ? `只有 ${g.players.length} 人` : `合计差 ${fmtSigned(v.games[k].diff)}`}</span>`}
        ${photo.saved.has(k) ? '<span class="small ok">✓ 已保存</span>' : photo.used.has(k) ? '<span class="small muted">已填入</span>' : ''}
      </button>`).join('')}
    ${v.totals.length ? `
      <div class="field-label" style="margin-top:10px">合计行验算（照片上的合计 vs 各场累加）：</div>
      <div class="verify">${v.totals.map((t) => `
        <span class="${t.ok ? 'ok' : 'bad'}">${esc(t.name)} <b class="num">${fmtNum(t.written)}</b>${t.ok ? ' ✓' : ` ✗ 累加为 <b class="num">${fmtNum(t.computed)}</b>`}</span>`).join('')}
      </div>` : '<p class="small muted" style="margin:8px 0 0">照片上没有合计行，无法和合计对照。</p>'}
    ${res.money?.length ? `
      <div class="field-label" style="margin-top:10px">钱数（仅供参考，不会记录）：</div>
      <div class="verify">${res.money.map((m) => `<span>${esc(m.name)} <b class="num">${fmtSigned(m.value)}</b></span>`).join('')}</div>` : ''}
    <p class="small ${badCount ? 'bad' : 'ok'}" style="margin:10px 0 0;font-weight:600">${badCount ? `⚠ 有 ${badCount} 处验算不一致，请对照照片检查` : '✓ 验算全部通过'}</p>
    ${res.notes ? `<p class="small muted">识别备注：${esc(res.notes)}</p>` : ''}`;
}

function applyRename(q) {
  const map = {};
  view.querySelectorAll('[data-rename]').forEach((el) => {
    const v = el.value.trim();
    if (v) map[photo.names[Number(el.dataset.rename)]] = v;
  });
  if (!Object.keys(map).length) return toast('请先填写要改成的名字');
  photo.result = renameRecognized(photo.result, map);
  renderAdd(q);
  toast(`已改名：${Object.entries(map).map(([a, b]) => `${a} → ${b}`).join('，')}`);
}

/** 把识别出的所有场次（和当日 chips）一次保存 */
function saveAllRecognized(q) {
  const r = rules();
  const res = photo.result;
  const date = form.date || today();
  const sameGame = (g, c) => g.date === date && g.players.join('\u0000') === c.players.join('\u0000') && g.scores.join() === c.scores.join();
  const saved = [], skipped = [];
  const base = Date.now();
  let lastPlayers = null;
  res.games.forEach((g, k) => {
    if (photo.saved.has(k)) return;
    const c = recognizedToGame(g, r);
    if (c.error) return skipped.push(`#${k + 1} ${c.error}`);
    if (store.games.some((x) => sameGame(x, c))) { photo.saved.add(k); return skipped.push(`#${k + 1} 已存在`); }
    store.saveGame({ id: uid(), date, createdAt: new Date(base + k).toISOString(), rules: r, players: c.players, scores: c.scores, note: form.note.trim() });
    photo.saved.add(k);
    saved.push(k);
    lastPlayers = c.players;
  });
  let chipsMsg = '';
  if (photo.saveChips && res.chips?.length) {
    const players = res.chips.map((c) => c.name.trim()).filter(Boolean);
    const old = store.getChipDay(date);
    if (new Set(players).size !== players.length) chipsMsg = '，chips 有重复名字未保存';
    else if (!old || confirm(`${date} 已有 chips 记录，用识别结果覆盖？`)) {
      store.saveChipDay({ date, players, chips: res.chips.filter((c) => c.name.trim()).map((c) => Math.round(Number(c.count) || 0)) });
      chipsMsg = '，chips 已保存';
      chipForm = null;
    }
  }
  if (lastPlayers) { const s = store.getSettings(); s.lastPlayers = lastPlayers; store.setSettings(s); }
  if (saved.length || chipsMsg.includes('已保存')) afterDataChange();
  renderAdd(q);
  const msg = `已保存 ${saved.length} 场（${date}）${chipsMsg}`;
  if (skipped.length) toast(`${msg}；跳过：${skipped.join('，')}`, 'error');
  else toast(msg);
}

async function runRecognize(q) {
  if (!photo || photo.loading) return;
  photo.loading = true;
  photo.error = null;
  renderAdd(q);
  try {
    photo.saved = new Set();
    photo.used = new Set();
    photo.result = await recognizeSheet(photo.file, store.getApiKey(), store.players(), store.getSettings().geminiModel);
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
  let ok = false;
  if (!c) st.innerHTML = '<span class="muted">填入四家数值（可留空一家自动补齐；负数可点 ± 切换）</span>';
  else if (c.diff === 0) { ok = true; st.innerHTML = `<span class="ok">✓ 合计 ${fmtScore(totalOf(r))}</span>`; }
  else st.innerHTML = `<span class="bad">✗ 合计 ${fmtScore(totalOf(r) + c.diff)}，与 ${fmtScore(totalOf(r))} 相差 ${fmtSigned(c.diff)}</span>`;
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
    // chips 改为每天记录一次；旧数据里每场的 chips 编辑时保留
    ...(old?.chips?.some(Boolean) ? { chips: old.chips } : {}),
    note: form.note.trim(),
  });
  const s = store.getSettings();
  s.lastPlayers = players;
  store.setSettings(s);
  const wasEdit = !!form.id;
  const { date, fromQuery } = form;
  form = null;
  afterDataChange();
  toast(wasEdit ? '已更新' : '已保存');
  if (wasEdit) location.hash = '#/list';
  else {
    // 同一天通常连打多场：保留日期，方便继续录入和最后记 chips
    form = { ...blankForm(), date, fromQuery };
    renderAdd(parseHash().q);
  }
}

// ---------- 当日 chips ----------
function ensureChipForm() {
  if (chipForm && chipForm.date === form.date) return;
  const rec = store.getChipDay(form.date);
  chipForm = { date: form.date, values: {}, extra: [] };
  rec?.players.forEach((p, i) => (chipForm.values[p] = String(rec.chips[i])));
}

/** 当天出场的玩家（按出场顺序）+ 已有记录里的玩家 + 手动添加的玩家 */
function chipNames() {
  const names = [];
  const add = (p) => p && !names.includes(p) && names.push(p);
  store.sortedGames().filter((g) => g.date === chipForm.date).forEach((g) => g.players.forEach(add));
  store.getChipDay(chipForm.date)?.players.forEach(add);
  chipForm.extra.forEach(add);
  return names;
}

function renderChipCard() {
  const el = $('#chip-card');
  if (!el) return;
  if (!form.date) { el.innerHTML = '<h2>当日 chips</h2><p class="muted small">请先选择日期。</p>'; return; }
  ensureChipForm();
  const names = (chipForm.names = chipNames());
  const rec = store.getChipDay(chipForm.date);
  const nGames = store.games.filter((g) => g.date === chipForm.date).length;
  el.innerHTML = `
    <div class="row" style="margin-bottom:4px">
      <h2 style="margin:0">当日 chips</h2>
      <span class="muted small">${esc(chipForm.date)} · 已录 ${nGames} 场${rec ? ' · 已保存' : ''}</span>
    </div>
    <p class="muted small" style="margin-top:4px">chips 每天只记一次：当天所有半庄打完后，在这里填写每人的 chips 合计。</p>
    ${names.length ? `<div class="chip-grid">${names.map((n, i) => `
      <label class="chip-row"><span class="n">${esc(n)}</span>${numField(`data-chip-idx="${i}"`, chipForm.values[n] ?? '', '0')}</label>`).join('')}
    </div>` : '<p class="muted small">这一天还没有对局。保存对局后，这里会列出当天的玩家；也可以手动添加。</p>'}
    <div class="row" style="margin-top:8px">
      <input id="chip-add" list="known-players" placeholder="添加玩家" autocomplete="off" style="max-width:160px">
      <button class="ghost" data-act="add-chip-player">添加</button>
    </div>
    <div id="chip-status" class="sum-status"></div>
    <div class="row" style="margin-top:8px">
      <button class="primary" data-act="save-chips" id="chip-save" ${names.length ? '' : 'disabled'}>保存 chips</button>
      ${rec ? '<button class="ghost danger" data-act="delete-chips">删除当日 chips</button>' : ''}
    </div>`;
  updateChipStatus();
}

function updateChipStatus() {
  const st = $('#chip-status');
  if (!st) return;
  const vals = chipForm.names.map((n) => toNum(chipForm.values[n]));
  if (vals.some((v) => Number.isNaN(v) || (v !== null && !Number.isInteger(v)))) {
    st.innerHTML = '<span class="bad">chips 必须是整数</span>';
    return;
  }
  const sum = vals.reduce((a, v) => a + (v || 0), 0);
  st.innerHTML = sum === 0
    ? '<span class="ok">✓ 合计 0</span>'
    : `<span class="bad">合计 ${fmtSigned(sum)}（通常应为 0，确认无误也可以保存）</span>`;
}

function addChipPlayer() {
  const input = $('#chip-add');
  const name = input.value.trim();
  if (!name) return;
  ensureChipForm();
  if (!chipForm.extra.includes(name)) chipForm.extra.push(name);
  renderChipCard();
  const i = chipForm.names.indexOf(name);
  $(`[data-chip-idx="${i}"]`)?.focus();
}

function saveChips() {
  const players = [], chips = [];
  for (const n of chipForm.names) {
    const v = toNum(chipForm.values[n]);
    if (v === null) continue;
    if (!Number.isInteger(v)) return toast(`${n} 的 chips 必须是整数`, 'error');
    players.push(n);
    chips.push(v);
  }
  if (!players.length) return toast('请至少填写一位玩家的 chips', 'error');
  store.saveChipDay({ date: chipForm.date, players, chips });
  chipForm = null;
  afterDataChange();
  renderChipCard();
  toast(`已保存 ${form.date} 的 chips`);
}

// ========== 记录列表 ==========
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const weekday = (date) => WEEKDAYS[new Date(`${date}T00:00:00`).getDay()];
const openDays = new Set(); // 展开了小局的日期
let movingDay = null;        // 正在改日期的那一天

/** 月历：标出打过的日子；选了玩家时按当天输赢着色 */
function calendarHtml(month, days, selected, me) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const offset = (first.getDay() + 6) % 7; // 周一开头
  const total = new Date(y, m, 0).getDate();
  const shift = (k) => { const d = new Date(y, m - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const played = [...days.keys()].filter((d) => d.startsWith(month)).length;
  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<span></span>';
  for (let d = 1; d <= total; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const info = days.get(date);
    if (!info) { cells += `<span class="cal-day${date === today() ? ' today' : ''}">${d}</span>`; continue; }
    const cls = me && info.myPt != null ? sign(info.myPt) : '';
    cells += `<button class="cal-day played ${cls}${date === selected ? ' on' : ''}${date === today() ? ' today' : ''}" data-cal-day="${date}" title="${date} · ${info.games} 场${me && info.myPt != null ? ` · ${esc(me)} ${fmtPt(info.myPt)}` : ''}">${d}<small>${info.games || 'c'}</small></button>`;
  }
  return `
  <div class="card cal">
    <div class="cal-head">
      <button class="ghost" data-cal-month="${shift(-1)}" aria-label="上个月">‹</button>
      <b>${y} 年 ${m} 月</b>
      <button class="ghost" data-cal-month="${shift(1)}" aria-label="下个月">›</button>
      <span class="spacer"></span>
      <span class="small muted">本月打了 ${played} 天</span>
    </div>
    <div class="cal-grid">${WEEKDAYS.slice(1).concat('日').map((w) => `<span class="cal-w">${w}</span>`).join('')}${cells}</div>
  </div>`;
}

function gameLine(g, k) {
  const rows = gameResult(g).sort((a, b) => a.rank - b.rank);
  return `
    <div class="gl">
      <span class="gl-i muted">#${k + 1}</span>
      <span class="gl-p">${rows.map((r) => `<span class="gl-r r${r.rank}"><span class="n">${esc(r.name)}</span> <b class="num">${fmtPt(r.pt)}</b> <small class="num">${fmtScore(r.score)}</small></span>`).join('')}</span>
      <span class="gl-a">
        ${store.pending.has(g.id) ? '<span class="tag">未同步</span>' : ''}
        <a href="#/add?id=${encodeURIComponent(g.id)}" class="small">编辑</a>
        <button class="link danger small" data-del="${esc(g.id)}">删除</button>
      </span>
    </div>`;
}

function dayCard(date, games, chipDay, me, open) {
  const stats = playerStats(games, chipDay ? [chipDay] : []).sort((a, b) => b.pt - a.pt);
  // 只有 chips、没有对局的玩家也列出来
  chipDay?.players.forEach((name, i) => {
    if (!stats.some((s) => s.name === name)) stats.push({ name, games: 0, pt: 0, rankCount: [0, 0, 0, 0], chips: chipDay.chips[i] || 0 });
  });
  const notes = [...new Set(games.map((g) => g.note).filter(Boolean))];
  const pending = games.some((g) => store.pending.has(g.id)) || (chipDay && store.pending.has(chipDay.id));
  return `
  <div class="card day">
    <div class="day-head">
      <b>${date.slice(5).replace('-', '/')}</b><span class="muted">周${weekday(date)}</span>
      <span class="tag">${games.length} 场</span>
      ${notes.map((n) => `<span class="small muted">${esc(n)}</span>`).join('')}
      ${pending ? '<span class="tag">未同步</span>' : ''}
      <span class="spacer"></span>
      <button class="link small" data-move-day="${date}">改日期</button>
      <a href="#/add?date=${encodeURIComponent(date)}" class="small">＋录入</a>
    </div>
    ${movingDay === date ? `
    <div class="move-day">
      <span class="small">把这天的全部小局${chipDay ? '和当日 chips' : ''}移到：</span>
      <input type="date" id="move-to" value="${date}">
      <button class="primary small" data-move-go="${date}">移动</button>
      <button class="ghost small" data-move-cancel>取消</button>
    </div>` : ''}
    <div class="ds-list">${stats.map((s) => `
      <div class="ds${s.name === me ? ' me' : ''}">
        <span class="n">${esc(s.name)}</span>
        <b class="num ${sign(s.pt)}">${s.games ? fmtPt(s.pt) : '—'}</b>
        <span class="rk small muted" title="1位-2位-3位-4位 次数">${s.games ? s.rankCount.join('-') : ''}</span>
        <span class="c small num ${sign(s.chips)}">${s.chips ? `${fmtSigned(s.chips)}枚` : ''}</span>
      </div>`).join('')}
    </div>
    ${games.length || chipDay ? `
    <details data-day="${date}" ${open ? 'open' : ''}>
      <summary class="small">小局 ${games.length} 场${chipDay ? ' · 当日 chips' : ''}</summary>
      ${games.map(gameLine).join('')}
      ${chipDay ? `
      <div class="gl chips-line small">
        <span class="muted">当日 chips</span><span class="spacer"></span>
        <a href="#/add?date=${encodeURIComponent(date)}">编辑</a>
        <button class="link danger small" data-del-chips="${esc(date)}">删除</button>
      </div>` : ''}
    </details>` : ''}
  </div>`;
}

function moveDayTo(from, to, q, go) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return toast('请选择新的日期', 'error');
  if (to === from) return toast('新日期和原日期相同', 'error');
  const n = store.games.filter((g) => g.date === from).length;
  const targetGames = store.games.filter((g) => g.date === to).length;
  const chips = store.getChipDay(from), targetChips = store.getChipDay(to);
  let msg = `把 ${from} 的 ${n} 场${chips ? '和当日 chips ' : ''}移到 ${to}？`;
  if (targetGames) msg += `\n${to} 已有 ${targetGames} 场，会合并到同一天。`;
  if (chips && targetChips) msg += `\n两天都有 chips，会按玩家相加。`;
  if (!confirm(msg)) return;
  const moved = store.moveDay(from, to);
  movingDay = null;
  if (openDays.delete(from)) openDays.add(to);
  afterDataChange();
  toast(`已把 ${moved} 场${chips ? '和 chips ' : ''}移到 ${to}`);
  // 正在只看原来那天时，跟着跳到新日期；否则跳到新日期所在的月份
  if (q.d === from) go({ d: to, m: to.slice(0, 7) });
  else if (q.m && q.m !== to.slice(0, 7)) go({ m: to.slice(0, 7) });
  else renderList(q);
}

function renderList(q) {
  const p = q.p || '', o = q.q || '', sel = q.d || '';
  const has = (list) => (!p || list.includes(p)) && (!o || list.includes(o));
  const games = store.sortedGames().filter((g) => has(g.players));
  const chipDays = new Map(store.chipDays.filter((d) => has(d.players)).map((d) => [d.date, d]));
  // 每天的汇总，供日历和列表使用
  const byDay = new Map();
  for (const g of games) (byDay.get(g.date) || byDay.set(g.date, []).get(g.date)).push(g);
  for (const d of chipDays.keys()) if (!byDay.has(d)) byDay.set(d, []);
  const days = new Map([...byDay].map(([date, gs]) => {
    const mine = p ? playerStats(gs, chipDays.has(date) ? [chipDays.get(date)] : []).find((x) => x.name === p) : null;
    return [date, { games: gs.length, myPt: mine ? mine.pt : null }];
  }));
  const dates = [...byDay.keys()].sort().reverse();
  const month = q.m || (sel || dates[0] || today()).slice(0, 7);
  const shown = sel ? dates.filter((d) => d === sel) : dates;

  let html = `
  <div class="filters">
    <label class="field">玩家<select data-f="p">${playerOptions(p, '全部')}</select></label>
    <label class="field">同桌<select data-f="q">${playerOptions(o, '不限')}</select></label>
    <span class="spacer"></span>
    <span class="muted small">${dates.length} 天 · ${games.length} 场</span>
  </div>
  ${calendarHtml(month, days, sel, p)}
  ${sel ? `<div class="row sel-day"><span>只看 <b>${sel}</b>（周${weekday(sel)}）</span><button class="ghost small" data-clear-day>显示全部日期</button></div>` : ''}`;
  if (!shown.length) html += `<div class="card empty">${sel ? '这一天没有记录。' : '没有记录。去「录入」添加第一场吧。'}</div>`;
  let curMonth = '';
  for (const date of shown) {
    const m = date.slice(0, 7);
    if (m !== curMonth) { curMonth = m; html += `<div class="month-head">${m.replace('-', ' 年 ')} 月</div>`; }
    html += dayCard(date, byDay.get(date), chipDays.get(date), p, !!sel || openDays.has(date));
  }
  view.innerHTML = html;

  const go = (patch) => {
    const nq = { ...q, ...patch };
    Object.keys(nq).forEach((k) => !nq[k] && delete nq[k]);
    location.hash = `#/list${Object.keys(nq).length ? `?${new URLSearchParams(nq)}` : ''}`;
  };
  bindView({
    click(e) {
      const t = e.target;
      const sum = t.closest('details[data-day] > summary');
      if (sum) {
        const d = sum.parentElement;
        // click 先于展开状态变化触发：当前是关着的，点完就是开的
        if (d.open) openDays.delete(d.dataset.day); else openDays.add(d.dataset.day);
        return;
      }
      const moveDay = t.closest('[data-move-day]')?.dataset.moveDay;
      if (moveDay) { movingDay = movingDay === moveDay ? null : moveDay; renderList(q); $('#move-to')?.focus(); return; }
      if (t.closest('[data-move-cancel]')) { movingDay = null; return renderList(q); }
      const moveFrom = t.closest('[data-move-go]')?.dataset.moveGo;
      if (moveFrom) return moveDayTo(moveFrom, $('#move-to').value, q, go);
      const calDay = t.closest('[data-cal-day]')?.dataset.calDay;
      if (calDay) return go({ d: calDay === sel ? '' : calDay, m: calDay.slice(0, 7) });
      const calMonth = t.closest('[data-cal-month]')?.dataset.calMonth;
      if (calMonth) return go({ m: calMonth });
      if (t.closest('[data-clear-day]')) return go({ d: '' });
      const chipDate = t.closest('[data-del-chips]')?.dataset.delChips;
      if (chipDate) {
        if (!confirm(`删除 ${chipDate} 的 chips 记录？`)) return;
        store.deleteChipDay(chipDate);
        afterDataChange();
        renderList(q);
        return toast('已删除');
      }
      const id = t.closest('[data-del]')?.dataset.del;
      if (!id || !confirm('确定删除这场对局？')) return;
      store.deleteGame(id);
      afterDataChange();
      renderList(q);
      toast('已删除');
    },
    change(e) {
      const f = e.target.dataset.f;
      if (f) go({ [f]: e.target.value });
    },
  });
}

// ========== 榜单 ==========
const PERIODS = [['all', '全部'], ['year', '今年'], ['month', '本月']];
const MIN_GAMES = [1, 5, 10, 20, 50];

const BOARD_TOP = 5; // 每张榜默认显示的人数，其余折叠

/**
 * 一张榜。bar(s) 返回 0–1，用于每行下方的比例条；icon 是榜单标题旁的小图标
 */
function boardCard({ key, title, hint, icon, rows, fmt, sub, bar, excluded = 0 }) {
  // 显示的数值相同就并列同一名次
  const ranks = [];
  rows.forEach((s, i) => ranks.push(i > 0 && fmt(rows[i - 1]) === fmt(s) ? ranks[i - 1] : i));
  const row = (s, i) => {
    const rank = ranks[i];
    const w = Math.max(0, Math.min(1, bar(s)));
    return `
      <li class="b-row${rank < 3 ? ` m${rank + 1}` : ''}">
        <span class="b-rank">${rank + 1}</span>
        <a class="b-main" href="#/stats?p=${encodeURIComponent(s.name)}">
          <span class="b-name">${esc(s.name)}</span>
          <span class="b-sub">${sub(s)}</span>
        </a>
        <b class="b-val num">${fmt(s)}</b>
        <span class="b-bar" aria-hidden="true"><i style="width:${(w * 100).toFixed(1)}%"></i></span>
      </li>`;
  };
  const top = rows.slice(0, BOARD_TOP), rest = rows.slice(BOARD_TOP);
  return `
  <section class="card board b-${key}">
    <header class="board-head">
      <span class="b-icon" aria-hidden="true">${icon}</span>
      <div><h3>${title}</h3><p>${hint}</p></div>
      <span class="b-count">${rows.length} 人</span>
    </header>
    ${rows.length ? `
    <ol class="board-list">${top.map(row).join('')}</ol>
    ${rest.length ? `
    <details class="b-more">
      <summary><span class="b-more-open">展开其余 ${rest.length} 人</span><span class="b-more-close">收起</span></summary>
      <ol class="board-list">${rest.map((s, i) => row(s, i + BOARD_TOP)).join('')}</ol>
    </details>` : ''}` : '<p class="b-empty">没有符合条件的玩家</p>'}
    ${excluded ? `<p class="b-note">另有 ${excluded} 人场数不足，未上榜</p>` : ''}
  </section>`;
}

function renderRank(q) {
  const period = PERIODS.some(([k]) => k === q.t) ? q.t : 'all';
  const min = MIN_GAMES.includes(Number(q.min)) ? Number(q.min) : 5;
  const t = today();
  const inPeriod = (d) => period === 'all' || (period === 'year' ? d.startsWith(t.slice(0, 4)) : d.startsWith(t.slice(0, 7)));
  const games = store.sortedGames().filter((g) => inPeriod(g.date));
  const chipDays = store.chipDays.filter((d) => inPeriod(d.date));
  const all = playerStats(games, chipDays);
  const qualified = all.filter((s) => s.games >= min);
  const excluded = all.length - qualified.length;
  // 狗率：只看有 chips 记录的人，最少场数按记了 chips 的场数算
  const withChips = all.filter((s) => s.dogRate !== null);
  const dogQualified = withChips.filter((s) => s.chipGames >= min);
  const by = (key, list) => list.slice().sort((a, b) => b[key] - a[key] || b.games - a.games || a.name.localeCompare(b.name));

  const maxRows = all.slice().sort((a, b) => b.maxScore - a.maxScore || a.maxScoreDate.localeCompare(b.maxScoreDate));
  const topsRows = by('tops', all);
  const dogRows = by('dogRate', dogQualified);
  const dogMax = dogRows[0]?.dogRate ?? 0, dogMin = dogRows.at(-1)?.dogRate ?? 0;

  let html = `
  <div class="filters">
    <div class="seg">${PERIODS.map(([k, label]) => `<button data-t="${k}" class="${k === period ? 'on' : ''}">${label}</button>`).join('')}</div>
    <label class="field">比率榜最少场数<select data-min>${MIN_GAMES.map((n) => `<option value="${n}" ${n === min ? 'selected' : ''}>${n} 场</option>`).join('')}</select></label>
    <span class="spacer"></span>
    <span class="muted small">${games.length} 场 · ${all.length} 人</span>
  </div>`;
  if (!games.length) html += '<div class="card empty">这段时间没有对局。</div>';
  else html += `<div class="boards">
    ${boardCard({ key: 'top', title: 'top 率', hint: '1 位次数 ÷ 场数', icon: '①', rows: by('topRate', qualified), excluded,
      fmt: (s) => pct(s.topRate), sub: (s) => `${s.tops} / ${s.games} 场`, bar: (s) => s.topRate })}
    ${boardCard({ key: 'rentai', title: '连对率', hint: '1 位 + 2 位的比例', icon: '②', rows: by('rentaiRate', qualified), excluded,
      fmt: (s) => pct(s.rentaiRate), sub: (s) => `${s.rankCount[0] + s.rankCount[1]} / ${s.games} 场`, bar: (s) => s.rentaiRate })}
    ${boardCard({ key: 'avoid', title: '避 4 率', hint: '没拿 4 位的比例', icon: '盾', rows: by('avoid4Rate', qualified), excluded,
      fmt: (s) => pct(s.avoid4Rate), sub: (s) => `4 位 ${s.rankCount[3]} 次 · ${s.games} 场`, bar: (s) => s.avoid4Rate })}
    ${boardCard({ key: 'max', title: '最高分', hint: '单场最高终局点数', icon: '高', rows: maxRows,
      fmt: (s) => fmtScore(s.maxScore), sub: (s) => esc(s.maxScoreDate), bar: (s) => s.maxScore / (maxRows[0]?.maxScore || 1) })}
    ${boardCard({ key: 'tops', title: 'top 次数', hint: '拿 1 位的总次数', icon: '冠', rows: topsRows,
      fmt: (s) => `${s.tops} 次`, sub: (s) => `${s.games} 场 · top 率 ${pct(s.topRate)}`, bar: (s) => s.tops / (topsRows[0]?.tops || 1) })}
    ${boardCard({ key: 'dog', title: '狗率', hint: '每个半庄平均 chips（只算记了 chips 的场次）', icon: '狗', rows: dogRows, excluded: withChips.length - dogQualified.length,
      fmt: (s) => `${s.dogRate > 0 ? '+' : ''}${s.dogRate.toFixed(2)}`, sub: (s) => `${fmtSigned(s.chips)} 枚 · ${s.chipGames} 场`,
      bar: (s) => (dogMax === dogMin ? 1 : (s.dogRate - dogMin) / (dogMax - dogMin)) })}
  </div>`;
  view.innerHTML = html;

  const go = (patch) => {
    const nq = { ...q, ...patch };
    if (nq.t === 'all') delete nq.t;
    if (Number(nq.min) === 5) delete nq.min;
    location.hash = `#/rank${Object.keys(nq).length ? `?${new URLSearchParams(nq)}` : ''}`;
  };
  bindView({
    click(e) { const k = e.target.closest('[data-t]')?.dataset.t; if (k) go({ t: k }); },
    change(e) { if (e.target.matches('[data-min]')) go({ min: e.target.value }); },
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

  const allStats = playerStats(games, store.chipDays);
  const s = me && allStats.find((x) => x.name === me);
  if (!games.length) html += '<div class="card empty">还没有记录。</div>';
  else if (!s) {
    const rows = allStats.sort((a, b) => b.pt - a.pt);
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
  const geminiModel = store.getSettings().geminiModel || DEFAULT_GEMINI_MODEL;
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
    <h2>照片识别（Gemini）</h2>
    <p class="muted small">在 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> 创建 API Key，并为该项目开通 <b>Billing</b>（付费层级，按量计费，识别一张不到一分钱；付费层级的数据不会被用于训练模型）。Key 只保存在当前浏览器，图片从浏览器直接发给 Google。</p>
    <details><summary>如何开通 Billing？</summary>
      <ol class="small muted">
        <li>打开 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>，点 <b>Create API key</b></li>
        <li>在 Key 所在项目的一行点 <b>Set up billing</b>，按提示绑定 Google Cloud 结算账号（需要信用卡）</li>
        <li>开通后该项目显示为 Paid tier（Tier 1），把 Key 复制到下方保存</li>
      </ol>
    </details>
    <div class="grid-2" style="margin-top:10px">
      <label class="field">Gemini API Key<input type="password" id="api-key" value="${esc(apiKey)}" placeholder="AIza…" autocomplete="off"></label>
      <label class="field">模型<input id="gemini-model" value="${esc(geminiModel)}" placeholder="${DEFAULT_GEMINI_MODEL}" autocomplete="off"></label>
    </div>
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
      } else if (act === 'save-key') {
        store.setApiKey($('#api-key').value.trim());
        const s = store.getSettings(); s.geminiModel = $('#gemini-model').value.trim() || DEFAULT_GEMINI_MODEL; store.setSettings(s);
        toast('已保存'); renderSettings();
      }
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
        let list, chipList = [];
        if (file.name.toLowerCase().endsWith('.csv')) list = importCSV(text);
        else {
          const j = JSON.parse(text);
          list = Array.isArray(j) ? j : j.games || [];
          chipList = Array.isArray(j) ? [] : j.chips || [];
        }
        const k = store.importGames(list, chipList);
        toast(`导入 ${k} 条记录`);
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
store.init().then(() => { view.dataset.ready = '1'; route(); });
