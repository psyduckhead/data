// 计分与统计（纯函数，可在 Node 中测试）

export const DEFAULT_RULES = { start: 25000, returnPts: 30000, uma: [20, 10, -10, -20] };

export const round1 = (x) => Math.round(x * 10) / 10;
export const totalOf = (rules) => rules.start * 4;
export const okaOf = (rules) => ((rules.returnPts - rules.start) * 4) / 1000;

/** 顺位（0 起）：高者在前，同值按座位顺序 */
export function ranks(values) {
  const order = values.map((_, i) => i).sort((a, b) => values[b] - values[a] || a - b);
  const rk = Array(values.length);
  order.forEach((seat, k) => (rk[seat] = k));
  return rk;
}

/** 终局点数 → 马点：(点数 − 返点)/1000 + 马，1 位另加头名赏 */
export function computePts(scores, rules) {
  const rk = ranks(scores);
  return scores.map((s, i) => round1((s - rules.returnPts) / 1000 + rules.uma[rk[i]] + (rk[i] === 0 ? okaOf(rules) : 0)));
}

/** 马点 → 终局点数（computePts 的逆运算） */
export function ptsToScores(pts, rules) {
  const rk = ranks(pts);
  return pts.map((p, i) => Math.round(((p - rules.uma[rk[i]] - (rk[i] === 0 ? okaOf(rules) : 0)) * 1000 + rules.returnPts) / 100) * 100);
}

/** 一场的结果：[{seat, name, score, pt, rank(1-4), chips}] */
export function gameResult(g) {
  const rk = ranks(g.scores);
  const pts = computePts(g.scores, g.rules);
  return g.players.map((name, i) => ({ seat: i, name, score: g.scores[i], pt: pts[i], rank: rk[i] + 1, chips: g.chips?.[i] || 0 }));
}

/** chipDays: 每天一条 chips 记录 [{date, players:[], chips:[]}]；旧数据里每场的 chips 也会计入 */
export function playerStats(games, chipDays = []) {
  const map = new Map();
  const get = (name) => map.get(name) || map.set(name, { name, games: 0, pt: 0, rankCount: [0, 0, 0, 0], chips: 0, maxScore: -Infinity, maxScoreDate: '' }).get(name);
  for (const g of games) {
    for (const r of gameResult(g)) {
      const s = get(r.name);
      s.games++;
      s.pt = round1(s.pt + r.pt);
      s.rankCount[r.rank - 1]++;
      s.chips += r.chips;
      if (r.score > s.maxScore) { s.maxScore = r.score; s.maxScoreDate = g.date; }
    }
  }
  for (const d of chipDays) {
    d.players.forEach((name, i) => { if (map.has(name)) map.get(name).chips += d.chips[i] || 0; });
  }
  return [...map.values()].map((s) => ({
    ...s,
    avgPt: s.pt / s.games,
    avgRank: s.rankCount.reduce((a, c, i) => a + c * (i + 1), 0) / s.games,
    tops: s.rankCount[0],
    topRate: s.rankCount[0] / s.games,
    avoid4Rate: 1 - s.rankCount[3] / s.games,
  }));
}

/** 指定玩家与每位对手同桌时的胜负：名次比对手高 = 胜 */
export function headToHead(games, me) {
  const map = new Map();
  for (const g of games) {
    const res = gameResult(g);
    const mine = res.find((r) => r.name === me);
    if (!mine) continue;
    for (const o of res) {
      if (o.name === me) continue;
      const h = map.get(o.name) || { name: o.name, games: 0, wins: 0, myPt: 0, oppPt: 0 };
      h.games++;
      if (mine.rank < o.rank) h.wins++;
      h.myPt = round1(h.myPt + mine.pt);
      h.oppPt = round1(h.oppPt + o.pt);
      map.set(o.name, h);
    }
  }
  return [...map.values()].map((h) => ({ ...h, losses: h.games - h.wins, winRate: h.wins / h.games }));
}

/**
 * 验算照片识别结果：
 * - 每场：点数合计应为 start×4，马点合计应为 0
 * - 合计行：应等于各场按人累加（照片上的合计可能是马点累加，也可能是原始数值或其简写，任一吻合即通过）
 */
export function verifyRecognized(res, rules) {
  const games = (res.games || []).map((g) => {
    const vals = g.players.map((p) => Number(p.value) || 0);
    const sum = vals.reduce((a, v) => a + v, 0);
    const diff = g.kind === 'pt' ? round1(sum) : sum - totalOf(rules);
    const pts = g.kind === 'pt' ? vals : (g.players.length === 4 ? computePts(vals, rules) : vals.map(() => NaN));
    return { ok: g.players.length === 4 && diff === 0, diff, pts };
  });
  const totals = (res.totals || []).map((t) => {
    let raw = 0, pt = 0, n = 0;
    (res.games || []).forEach((g, k) => {
      const i = g.players.findIndex((p) => p.name.trim() === t.name.trim());
      if (i < 0) return;
      n++;
      raw += Number(g.players[i].value) || 0;
      pt += games[k].pts[i];
    });
    const written = Number(t.value);
    const candidates = [round1(pt), raw, raw / 100, raw / 1000];
    const match = candidates.find((c) => Number.isFinite(c) && Math.abs(c - written) < 0.05);
    return { name: t.name, written, computed: match ?? round1(pt), games: n, ok: match !== undefined };
  });
  return { games, totals, allOk: games.every((g) => g.ok) && totals.every((t) => t.ok) };
}

/** 把识别出的一场转换成可保存的 {players, scores}；不合格时返回 {error} */
export function recognizedToGame(g, rules) {
  const players = (g.players || []).map((p) => String(p.name || '').trim());
  if (players.length !== 4) return { error: `只有 ${players.length} 人` };
  if (players.some((p) => !p)) return { error: '有玩家名为空' };
  if (new Set(players).size !== 4) return { error: '玩家名重复' };
  const vals = g.players.map((p) => Number(p.value));
  if (vals.some((v) => !Number.isFinite(v))) return { error: '有数值无法识别' };
  if (g.kind === 'pt' && round1(vals.reduce((a, v) => a + v, 0)) !== 0) return { error: '马点合计不为 0' };
  const scores = g.kind === 'pt' ? ptsToScores(vals, rules) : vals;
  const diff = scores.reduce((a, v) => a + v, 0) - totalOf(rules);
  if (diff !== 0) return { error: `合计差 ${diff > 0 ? '+' : ''}${diff}` };
  return { players, scores };
}

/** 按 {旧名: 新名} 批量改名识别结果（场次、chips、合计、钱数），返回新对象 */
export function renameRecognized(res, map) {
  const fix = (name) => {
    const k = String(name ?? '').trim();
    return map[k] !== undefined && map[k].trim() ? map[k].trim() : name;
  };
  const list = (arr) => (arr || []).map((x) => ({ ...x, name: fix(x.name) }));
  return {
    ...res,
    games: (res.games || []).map((g) => ({ ...g, players: list(g.players) })),
    chips: list(res.chips),
    totals: list(res.totals),
    money: list(res.money),
  };
}
