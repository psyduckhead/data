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
    notes: { type: 'STRING', description: '看不清或不确定的地方，没有则为空字符串' },
  },
  required: ['games', 'chips', 'notes'],
  propertyOrdering: ['games', 'chips', 'notes'],
};

const PROMPT = (known) => `这是一张日本立直麻将（四人）的手写记分表照片。请读出其中每一场的四位玩家和数值。

- 每一场通常是一行或一列，四个数值对应四位玩家；玩家名一般写在表头。
- 数值可能是「终局点数」（如 41000，或简写成 410 / 41.0 表示 41000，四人合计约 100000）——此时 kind = "score"，value 一律换算成完整点数（例如 410 → 41000）。
- 也可能是「马点 / pt」（如 +60、-25.0、▲15，四人合计约 0）——此时 kind = "pt"，▲ 或 △ 表示负数。
- chip / チップ / 枚 一般是当天最后统一记录一次，填写到 chips（每人当天合计数量，可为负）。
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
  return { games: result.games || [], chips: result.chips || [], notes: result.notes || '' };
}
