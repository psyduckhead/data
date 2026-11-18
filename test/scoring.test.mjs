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
