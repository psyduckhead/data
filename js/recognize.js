// 用 Gemini API 识别手写记分照片。API Key 只保存在浏览器本地，请求直接从浏览器发往 Google。

export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Gemini responseSchema（OpenAPI 子集）
const PLAYER_VALUE = {
  type: 'OBJECT',
  properties: { name: { type: 'STRING' }, value: { type: 'NUMBER' } },
  required: ['name', 'value'],
  propertyOrdering: ['name', 'value'],
};
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    games: {
      type: 'ARRAY',
      description: '照片中的每一场（半庄）',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', format: 'enum', enum: ['score', 'pt'], description: 'score=终局点数，pt=马点' },
          players: { type: 'ARRAY', items: PLAYER_VALUE },
        },
        required: ['kind', 'players'],
        propertyOrdering: ['kind', 'players'],
      },
    },
    chips: {
      type: 'ARRAY',
      description: '每位玩家当天的 chip 合计（没有写则为空数组）',
      items: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, count: { type: 'INTEGER' } },
        required: ['name', 'count'],
        propertyOrdering: ['name', 'count'],
      },
    },
    totals: {
      type: 'ARRAY',
      description: '表格底部的「合计」行（每人各场累加），照原样记录；没有则为空数组',
      items: PLAYER_VALUE,
    },
    money: {
      type: 'ARRAY',
      description: '表格底部的「钱数」行（较大的整数），照原样记录；没有则为空数组',
      items: PLAYER_VALUE,
    },
    notes: { type: 'STRING', description: '看不清或不确定的地方、合计验算不一致的地方，没有则为空字符串' },
  },
  required: ['games', 'chips', 'totals', 'money', 'notes'],
  propertyOrdering: ['chips', 'games', 'totals', 'money', 'notes'],
};

const PROMPT = (known) => `这是一张日本立直麻将（四人）一天的手写记分表照片。请按下面的版式读出数据。

表格版式（一般如此，但请以照片为准）：
1. 第一行是玩家名。名字旁边的数字是该玩家当天的 chip 数量（可为负，▲ / △ 表示负数），填到 chips；名字旁边没有数字的玩家不要填。
2. 中间每一行是一场（半庄），四个数值依次对应第一行的四位玩家，填到 games。
   - 数值可能是「终局点数」（如 41000，或简写成 410 / 41.0 表示 41000，四人合计约 100000）——此时 kind = "score"，value 一律换算成完整点数（例如 410 → 41000）。
   - 也可能是「马点 / pt」（如 +60、-25.0、▲15，四人合计约 0）——此时 kind = "pt"，▲ 或 △ 表示负数。
   - 如果有人这一场没上桌（五人以上轮换），只填上桌的四人。
3. 最后一到两行可能是「合计」和/或「钱数」，它们不是场次，绝对不要放进 games：
   - 合计：每人各场数值的累加，填到 totals（照原样记录数值）。
   - 钱数：通常是比较大的整数（如 1500、-2300），填到 money（照原样记录）。
   - 也可能两行都没有，此时 totals 和 money 为空数组。判断最后几行是不是场次时，可以验算：某一行如果等于上面各场按人累加的结果，就是合计行。
4. 请自己验算：每场四人合计应为 100000（点数）或 0（马点）；合计行应等于各场累加。不一致时先重新看一遍数字，仍不一致就在 notes 里写明是哪一场、哪位玩家。

- 已知玩家名：${known.length ? known.join('、') : '（无）'}。手写名字与已知玩家相近时请用已知名字。
- 不要猜测看不清的数字；把不确定的地方写在 notes 里。`;

/** 缩小图片（长边 ≤ 2048px）并转成 JPEG base64 */
async function toJpegBase64(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.9);
  return url.slice(url.indexOf(',') + 1);
}

function apiError(status, err) {
  const msg = err?.message || '';
  const code = err?.status || '';
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Gemini API Key 无效，请在「设置」中检查';
  if (code === 'FAILED_PRECONDITION' || /billing|location is not supported|free tier/i.test(msg)) {
    return '需要为 Gemini API 开通付费（Billing）：在 aistudio.google.com 的 API Keys 页面为该项目「Set up billing」后再试';
  }
  if (status === 403 || code === 'PERMISSION_DENIED') return '该 API Key 没有权限（请确认项目已启用 Generative Language API）';
  if (status === 404 || code === 'NOT_FOUND') return `找不到模型，请在「设置」中检查模型名称：${msg}`;
  if (status === 429 || code === 'RESOURCE_EXHAUSTED') return '请求太频繁或超出配额，请稍后再试（免费额度用完时请开通 Billing）';
  if (status >= 500) return `Gemini 服务暂时不可用（HTTP ${status}），请稍后再试`;
  return `识别失败（HTTP ${status}）：${msg}`;
}

export async function recognizeSheet(file, apiKey, knownPlayers = [], model = DEFAULT_GEMINI_MODEL) {
  const data = await toJpegBase64(file);
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data } },
        { text: PROMPT(knownPlayers) },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
    },
  };
  let res;
  try {
    res = await fetch(`${API_BASE}/${encodeURIComponent(model || DEFAULT_GEMINI_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('无法连接 Gemini API，请检查网络');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(apiError(res.status, json.error));

  if (json.promptFeedback?.blockReason) throw new Error(`图片被拦截（${json.promptFeedback.blockReason}），请换一张再试`);
  const cand = json.candidates?.[0];
  if (!cand) throw new Error('没有得到识别结果');
  if (cand.finishReason === 'MAX_TOKENS') throw new Error('识别结果过长被截断，请裁剪图片后再试');
  if (cand.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) {
    throw new Error(`模型未能完成识别（${cand.finishReason}），请换一张再试`);
  }
  const text = (cand.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) throw new Error('没有得到识别结果');
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('识别结果格式错误，请重试'); }
  return { games: result.games || [], chips: result.chips || [], totals: result.totals || [], money: result.money || [], notes: result.notes || '' };
}
