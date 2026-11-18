import assert from 'node:assert/strict';
import { DEFAULT_RULES as R, ranks, computePts, ptsToScores, gameResult, playerStats, headToHead } from '../js/scoring.js';
import { mergeGames } from '../js/store.js';

// 用户例子：1 位 50000 → (50000-30000)/1000 + 20 + 20 = +60.0
const s1 = [50000, 30000, 15000, 5000];
assert.deepEqual(computePts(s1, R), [60, 10, -25, -45]);
assert.equal(computePts(s1, R).reduce((a, b) => a + b, 0), 0);
// 马点 → 点数
assert.deepEqual(ptsToScores([60, 10, -25, -45], R), s1);
const s2 = [32100, 41000, 8400, 18500];
assert.deepEqual(ptsToScores(computePts(s2, R), R), s2);
assert.deepEqual(computePts(s2, R), [12.1, 51, -41.6, -21.5]);
// 负分
const s3 = [-3200, 61200, 22000, 20000];
assert.deepEqual(ptsToScores(computePts(s3, R), R), s3);
// 同点按座位
assert.deepEqual(ranks([30000, 30000, 20000, 20000]), [0, 1, 2, 3]);

const G = (players, scores, chips = [0, 0, 0, 0]) => ({ id: players.join() + scores, date: '2026-11-01', rules: R, players, scores, chips });
const games = [
  G(['A', 'B', 'C', 'D'], [50000, 30000, 15000, 5000], [3, -1, 0, -2]),
  G(['B', 'A', 'C', 'E'], [40000, 30000, 20000, 10000]),
  G(['C', 'D', 'A', 'B'], [40000, 30000, 20000, 10000]),
];
assert.equal(gameResult(games[0])[0].rank, 1);
const A = playerStats(games).find((s) => s.name === 'A');
assert.equal(A.games, 3); assert.equal(A.chips, 3); assert.deepEqual(A.rankCount, [1, 1, 1, 0]);
assert.equal(A.pt, 60 + 10 - 20);
// 当日 chips 记录与旧的每场 chips 一起计入
const withDay = Object.fromEntries(playerStats(games, [{ date: '2026-11-01', players: ['A', 'B', 'Z'], chips: [5, -3, -2] }]).map((x) => [x.name, x]));
assert.equal(withDay.A.chips, 8); assert.equal(withDay.B.chips, -4);
assert.equal(withDay.Z, undefined); // 没有对局的玩家不进排行榜
const h = Object.fromEntries(headToHead(games, 'A').map((x) => [x.name, x]));
assert.equal(h.B.games, 3); assert.equal(h.B.wins, 2); assert.equal(h.B.losses, 1);
assert.equal(h.C.games, 3); assert.equal(h.C.wins, 2);
assert.equal(h.E.games, 1); assert.equal(h.E.winRate, 1);
assert.equal(h.D.wins, 1); assert.equal(h.D.games, 2);

const merged = mergeGames([{ id: 'a', updatedAt: '1' }, { id: 'b' }], [{ id: 'a', updatedAt: '2', x: 1 }], new Set(['a']), new Set(['b']));
assert.deepEqual(merged, [{ id: 'a', updatedAt: '2', x: 1 }]);
console.log('all tests passed');

// 照片识别验算
{
  const { verifyRecognized } = await import('../js/scoring.js');
  const P = (names, vals) => names.map((name, i) => ({ name, value: vals[i] }));
  const N = ['A', 'B', 'C', 'D'];
  const res = {
    games: [
      { kind: 'pt', players: P(N, [60, 10, -25, -45]) },
      { kind: 'score', players: P(N, [30000, 40000, 20000, 10000]) }, // pt: 10, 50, -20, -40
      { kind: 'pt', players: P(N, [10, 10, -20, 1]) },                 // 合计不为 0
    ],
    totals: P(N, [80, 70, -65, -84]),                                  // 各场马点按人累加
  };
  const v = verifyRecognized(res, R);
  assert.deepEqual(v.games.map((g) => g.ok), [true, true, false]);
  assert.equal(v.games[2].diff, 1);
  assert.deepEqual(v.totals.map((t) => t.ok), [true, true, true, true]);
  const bad = verifyRecognized({ games: res.games.slice(0, 2), totals: P(N, [70, 60, -45, -80]) }, R);
  assert.deepEqual(bad.totals.map((t) => t.ok), [true, true, true, false]);
  assert.equal(bad.totals[3].computed, -85);
  assert.equal(bad.allOk, false);
  // 合计按原始点数简写（千点）也能吻合
  const raw = verifyRecognized({ games: [res.games[1]], totals: P(N, [30, 40, 20, 10]) }, R);
  assert.ok(raw.totals.every((t) => t.ok));
}
console.log('verify tests passed');

// 识别结果 → 对局；批量改名
{
  const { recognizedToGame, renameRecognized } = await import('../js/scoring.js');
  const P = (names, vals) => names.map((name, i) => ({ name, value: vals[i] }));
  assert.deepEqual(recognizedToGame({ kind: 'pt', players: P(['A', 'B', 'C', 'D'], [60, 10, -25, -45]) }, R),
    { players: ['A', 'B', 'C', 'D'], scores: [50000, 30000, 15000, 5000] });
  assert.deepEqual(recognizedToGame({ kind: 'score', players: P(['A', 'B', 'C', 'D'], [50000, 30000, 15000, 5000]) }, R).scores, [50000, 30000, 15000, 5000]);
  assert.equal(recognizedToGame({ kind: 'pt', players: P(['A', 'B', 'C', 'D'], [60, 10, -25, -44]) }, R).error, '马点合计不为 0');
  assert.equal(recognizedToGame({ kind: 'score', players: P(['A', 'A', 'C', 'D'], [50000, 30000, 15000, 5000]) }, R).error, '玩家名重复');
  assert.equal(recognizedToGame({ kind: 'score', players: P(['A', 'B', 'C'], [50000, 30000, 20000]) }, R).error, '只有 3 人');
  const res = { games: [{ kind: 'pt', players: P(['小明', '小江', 'C', 'D'], [1, 2, 3, -6]) }], chips: [{ name: '小江', count: 2 }], totals: P(['小江'], [2]), money: [] };
  const rn = renameRecognized(res, { 小江: '小红', 小明: '' });
  assert.deepEqual(rn.games[0].players.map((p) => p.name), ['小明', '小红', 'C', 'D']);
  assert.equal(rn.chips[0].name, '小红'); assert.equal(rn.totals[0].name, '小红');
  assert.equal(res.chips[0].name, '小江'); // 不修改原对象
}
console.log('recognize helpers tests passed');
