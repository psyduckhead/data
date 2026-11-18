// 用 Claude 识别手写记分照片。API Key 只保存在浏览器本地，请求直接从浏览器发往 Anthropic。

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.4.0/+esm';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['games', 'chips', 'notes'],
  properties: {
    games: {
      type: 'array',
      description: '照片中的每一场（半庄）',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'players'],
        properties: {
          kind: { type: 'string', enum: ['score', 'pt'], description: 'score=终局点数，pt=马点' },
          players: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'value'],
              properties: { name: { type: 'string' }, value: { type: 'number' } },
            },
          },
        },
      },
    },
    chips: {
      type: 'array',
      description: '每位玩家的 chip 数量（没有写则为空数组）',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'count'],
        properties: { name: { type: 'string' }, count: { type: 'integer' } },
      },
    },
    notes: { type: 'string', description: '看不清或不确定的地方，没有则为空字符串' },
  },
};

const PROMPT = (known) => `这是一张日本立直麻将（四人）的手写记分表照片。请读出其中每一场的四位玩家和数值。

- 每一场通常是一行或一列，四个数值对应四位玩家；玩家名一般写在表头。
- 数值可能是「终局点数」（如 41000，或简写成 410 / 41.0 表示 41000，四人合计约 100000）——此时 kind = "score"，value 一律换算成完整点数（例如 410 → 41000）。
- 也可能是「马点 / pt」（如 +60、-25.0、▲15，四人合计约 0）——此时 kind = "pt"，▲ 或 △ 表示负数。
- 如果有 chip / チップ / 枚 等记录，填写到 chips（每人合计数量，可为负）。
- 已知玩家名：${known.length ? known.join('、') : '（无）'}。手写名字与已知玩家相近时请用已知名字。
- 不要猜测看不清的数字；把不确定的地方写在 notes 里。`;

/** 缩小图片（长边 ≤ 1568px）并转成 JPEG base64 */
async function toJpegBase64(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.9);
  return url.slice(url.indexOf(',') + 1);
}

export async function recognizeSheet(file, apiKey, knownPlayers = []) {
  const { default: Anthropic } = await import(SDK_URL);
  // 用户自己的 Key、自己的浏览器，所以允许浏览器直连
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const data = await toJpegBase64(file);
  let response;
  try {
    response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: PROMPT(knownPlayers) },
        ],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('API Key 无效，请在「设置」中检查');
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error('该 API Key 没有权限使用此模型');
    if (err instanceof Anthropic.RateLimitError) throw new Error('请求太频繁或额度不足，请稍后再试');
    if (err instanceof Anthropic.APIConnectionError) throw new Error('无法连接 Anthropic，请检查网络');
    if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) throw new Error('Anthropic 账户余额不足，请到 console.anthropic.com 的 Plans & Billing 充值');
    if (err instanceof Anthropic.APIError) throw new Error(`识别失败（HTTP ${err.status}）：${err.message}`);
    throw err;
  }
  if (response.stop_reason === 'refusal') throw new Error('模型拒绝了这张图片，请换一张再试');
  if (response.stop_reason === 'max_tokens') throw new Error('识别结果过长被截断，请裁剪图片后再试');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('没有得到识别结果');
  return JSON.parse(text);
}
