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
  const get = (name) => map.get(name) || map.set(name, { name, games: 0, pt: 0, rankCount: [0, 0, 0, 0], chips: 0 }).get(name);
  for (const g of games) {
    for (const r of gameResult(g)) {
      const s = get(r.name);
      s.games++;
      s.pt = round1(s.pt + r.pt);
      s.rankCount[r.rank - 1]++;
      s.chips += r.chips;
    }
  }
  for (const d of chipDays) {
    d.players.forEach((name, i) => { if (map.has(name)) map.get(name).chips += d.chips[i] || 0; });
  }
  return [...map.values()].map((s) => ({
    ...s,
    avgPt: s.pt / s.games,
    avgRank: s.rankCount.reduce((a, c, i) => a + c * (i + 1), 0) / s.games,
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
