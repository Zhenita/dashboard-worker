/**
 * Gemini OCR Worker v2
 * 
 * 功能：
 * - POST / → 接收图片，用 Gemini Vision 识别，返回结构化数据
 * - POST /feishu → 接收字段映射，写入飞书
 * 
 * 环境变量（在 Cloudflare Workers 设置）：
 *   GEMINI_API_KEY      = 你的 Gemini API Key
 *   FEISHU_APP_ID       = 飞书 App ID
 *   FEISHU_APP_SECRET   = 飞书 App Secret
 */

const GEMINI_MODEL = "gemini-2.0-flash";
const FEISHU_BASE = "https://open.feishu.cn/open-apis";

// ════════════════════════════════════════════════
// Worker Entry
// ════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return cors(null, 204, origin);
    }

    try {
      // POST / → OCR 识别
      if (url.pathname === "/" && request.method === "POST") {
        return await handleOCR(request, env, origin);
      }

      // POST /feishu → 写入飞书
      if (url.pathname === "/feishu" && request.method === "POST") {
        return await handleFeishu(request, env, origin);
      }

      // Health check
      if (url.pathname === "/") {
        return cors({ ok: true, service: "Gemini OCR Worker v2" }, 200, origin);
      }

      return cors({ ok: false, error: "not found" }, 404, origin);
    } catch (e) {
      console.error("Error:", e);
      return cors({ ok: false, error: e.message }, 500, origin);
    }
  },
};

// ════════════════════════════════════════════════
// OCR with Gemini Vision
// ════════════════════════════════════════════════
async function handleOCR(request, env, origin) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!file) {
    return cors({ ok: false, error: "No file provided" }, 400, origin);
  }

  try {
    // Convert file to base64
    const buffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

    // Determine MIME type
    let mediaType = file.type;
    if (!mediaType || mediaType === "application/octet-stream") {
      if (file.name.endsWith(".pdf")) mediaType = "application/pdf";
      else if (file.name.endsWith(".png")) mediaType = "image/png";
      else if (file.name.endsWith(".jpg") || file.name.endsWith(".jpeg"))
        mediaType = "image/jpeg";
      else mediaType = "image/jpeg"; // default
    }

    // Call Gemini Vision API
    const prompt = `你是一个单据识别专家。请分析这张单据图片，提取以下信息并返回 JSON 格式：

{
  "header": {
    "供应商/客户": "单据上的公司或个人名称",
    "日期": "YYYY-MM-DD 格式的日期",
    "订单编号": "订单/单据号码",
    "币种": "CNY/USD/EUR 等",
    "订单金额": "数字，不含符号",
    "下单数量": "总数量",
    "备注/用途说明": "备注或特殊说明"
  },
  "items": [
    {
      "item": "产品名称",
      "qty": "数量（数字）",
      "unitPrice": "单价（数字）",
      "subtotal": "小计（数字）"
    }
  ]
}

要求：
1. 如果找不到某个字段，返回空字符串或空数组
2. 数字字段只返回数值，不要包含货币符号
3. 日期必须是 YYYY-MM-DD 格式
4. 如果有多行商品，在 items 数组中列出
5. 如果没有行项目，items 返回空数组
6. 只返回 JSON，不要其他文字`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: mediaType,
                    data: base64,
                  },
                },
                {
                  text: prompt,
                },
              ],
            },
          ],
        }),
      }
    );

    if (!geminiResponse.ok) {
      const err = await geminiResponse.text();
      throw new Error(`Gemini API error: ${err}`);
    }

    const geminiData = await geminiResponse.json();
    const textContent =
      geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    // Parse JSON response
    let result;
    try {
      // Extract JSON from response (might have markdown formatting)
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch ? jsonMatch[0] : textContent);
    } catch (e) {
      result = { error: `Failed to parse Gemini response: ${e.message}` };
    }

    return cors({ ok: true, ...result }, 200, origin);
  } catch (e) {
    return cors({ ok: false, error: e.message }, 500, origin);
  }
}

// ════════════════════════════════════════════════
// Write to Feishu
// ════════════════════════════════════════════════
async function handleFeishu(request, env, origin) {
  const body = await request.json();
  const { appId, appSecret, appToken, tableId, fields, records } = body;

  if (!appId || !appSecret || !appToken || !tableId) {
    return cors(
      {
        ok: false,
        error: "Missing required: appId, appSecret, appToken, tableId",
      },
      400,
      origin
    );
  }

  try {
    // Get tenant access token
    const tokenResp = await fetch(
      `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: appId,
          app_secret: appSecret,
        }),
      }
    );

    if (!tokenResp.ok) {
      throw new Error(`Feishu token error: ${tokenResp.status}`);
    }

    const tokenData = await tokenResp.json();
    const token = tokenData.tenant_access_token;

    if (!token) {
      throw new Error("Failed to get Feishu access token: " + JSON.stringify(tokenData));
    }

    // Write record(s)
    let result;

    if (records && Array.isArray(records)) {
      // Batch write multiple records
      const writeResp = await fetch(
        `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            records: records.map((r) => ({ fields: r })),
          }),
        }
      );

      if (!writeResp.ok) {
        const err = await writeResp.text();
        throw new Error(`Feishu write error: ${err}`);
      }

      result = await writeResp.json();
      return cors(
        {
          ok: true,
          code: result.code,
          msg: result.msg,
          data: {
            success_count: result.data?.records?.length || 0,
            records: result.data?.records,
          },
        },
        200,
        origin
      );
    } else if (fields) {
      // Single record write
      const writeResp = await fetch(
        `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            fields: fields,
          }),
        }
      );

      if (!writeResp.ok) {
        const err = await writeResp.text();
        throw new Error(`Feishu write error: ${err}`);
      }

      result = await writeResp.json();
      return cors(
        {
          ok: true,
          code: result.code,
          msg: result.msg,
          data: {
            record: result.data?.record,
          },
        },
        200,
        origin
      );
    } else {
      return cors(
        { ok: false, error: "Neither fields nor records provided" },
        400,
        origin
      );
    }
  } catch (e) {
    return cors({ ok: false, error: e.message }, 500, origin);
  }
}

// ════════════════════════════════════════════════
// CORS
// ════════════════════════════════════════════════
function cors(body, status, origin) {
  return new Response(body !== null ? JSON.stringify(body) : null, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Cache-Control": "no-cache",
    },
  });
}
