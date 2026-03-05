/**
 * N7R OPS — Cloudflare Worker v4
 *
 * 环境变量：
 *   FEISHU_APP_ID     = cli_a922cf9adef8dbc6
 *   FEISHU_APP_SECRET = GJz3kXbHMoxOkyotIQC61eJnB6lAQoGG
 *
 * ★ 新增 /api/raw?table=productionOrders
 *   → 返回原始字段名，用来排查「描述/数量为空」的问题
 */

const FEISHU_BASE = "https://open.feishu.cn/open-apis";
const APP_TOKEN   = "R9HBwFnARifUbQkQ54NcdASLnrc";

// ── 各表 ID（已由用户在 Cloudflare 填写）────────────────────────────────
const TABLES = {
  products:         "tbl64Snllt6Foss9",
  productionOrders: "tblyUdlkUkAGiJwo",
  bOrders:          "tbl1vDHZlSKGBeI7",
  advances:         "tbl7FGIDEtkZBid8",
  shipments:        "tbl5tQRwRLchLiL8",
  invoices:         "tbl9EmtJeZ7enX5b",
};

// ── 字段映射 ── 左边 = 飞书实际列名，右边 = Dashboard key ────────────
// 如果「描述/数量」空白，访问 /api/raw?table=productionOrders 查看真实列名，改这里
const MAPS = {
  products: {
    "SKU":          "sku",
    "产品名称":     "name",
    "类别":         "category",
    "研发阶段":     "stage",
    "状态":         "status",
    "供应商":       "supplier",
    "成本":         "cost",
    "备注":         "notes",
  },
  productionOrders: {
    "订单编号":     "orderNo",
    "SKU":          "sku",
    "产品名称":     "product",
    // ↓↓ 数量/描述最可能对不上，下面列出所有常见写法，命中一个就够
    "数量":         "qty",
    "Qty":          "qty",
    "QTY":          "qty",
    "件数":         "qty",
    "产品描述":     "desc",
    "描述":         "desc",
    "规格":         "desc",
    "备注":         "notes",
    "订单金额":     "amount",
    "金额":         "amount",
    "已付金额":     "paidAmount",
    "已付款":       "paidAmount",
    "生产状态":     "status",
    "状态":         "status",
    "付款状态":     "payStatus",
    "来源":         "source",
    "Zoho ID":      "zohoId",
    "下单日期":     "date",
    "日期":         "date",
  },
  bOrders: {
    "订单编号":     "orderNo",
    "订单类型":     "orderType",
    "SKU":          "sku",
    "客户名称":     "customer",
    "客户":         "customer",
    "下单日期":     "date",
    "日期":         "date",
    "产品名称":     "product",
    "产品描述":     "desc",
    "描述":         "desc",
    "报告期":       "reportPeriod",
    "数量":         "qty",
    "Qty":          "qty",
    "币种":         "currency",
    "订单金额":     "amount",
    "金额":         "amount",
    "已收金额":     "paidAmount",
    "已收款":       "paidAmount",
    "付款状态":     "payStatus",
    "履约状态":     "status",
    "状态":         "status",
    "开票状态":     "invoiceStatus",
    "来源":         "source",
    "Zoho ID":      "zohoId",
    "备注":         "notes",
  },
  advances: {
    "日期":         "date",
    "用途说明":     "purpose",
    "用途":         "purpose",
    "类型":         "type",
    "垫付金额":     "amount",
    "金额":         "amount",
    "已还金额":     "returned",
    "已还":         "returned",
    "还款状态":     "status",
    "状态":         "status",
    "关联订单号":   "relatedOrder",
    "关联订单":     "relatedOrder",
    "备注":         "notes",
  },
  shipments: {
    "日期":         "date",
    "方向":         "direction",
    "对方名称":     "counterpart",
    "关联订单号":   "relatedOrder",
    "关联订单":     "relatedOrder",
    "SKU":          "sku",
    "产品名称":     "product",
    "数量":         "qty",
    "物流单号":     "tracking",
    "备注":         "notes",
  },
  invoices: {
    "发票号":       "invoiceNo",
    "客户名称":     "customer",
    "客户":         "customer",
    "开票金额":     "amount",
    "金额":         "amount",
    "币种":         "currency",
    "开票状态":     "status",
    "状态":         "status",
    "关联订单号":   "relatedOrder",
    "关联订单":     "relatedOrder",
    "备注":         "notes",
  },
};

// ════════════════════════════════════════════════════════
// Worker entry
// ════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";
    if (request.method === "OPTIONS") return cors(null, 204, origin);

    try {
      const token = await getToken(env);

      // GET /api/all — all tables
      if (url.pathname === "/api/all") {
        const keys = Object.keys(TABLES);
        const results = await Promise.all(keys.map(k => fetchTable(token, TABLES[k], MAPS[k] || {})));
        const data = {};
        keys.forEach((k, i) => data[k] = results[i]);
        return cors({ ok: true, data, ts: Date.now() }, 200, origin);
      }

      // GET /api/raw?table=productionOrders — raw fields for debugging
      if (url.pathname === "/api/raw") {
        const name = url.searchParams.get("table") || "productionOrders";
        if (!TABLES[name]) return cors({ ok: false, error: "unknown: " + name }, 400, origin);
        const rows = await fetchRaw(token, TABLES[name]);
        return cors({ ok: true, table: name, sample: rows.slice(0, 3), allKeys: extractAllKeys(rows) }, 200, origin);
      }

      // GET /api/table?name=xxx
      if (url.pathname === "/api/table") {
        const name = url.searchParams.get("name");
        if (!TABLES[name]) return cors({ ok: false, error: "unknown: " + name }, 400, origin);
        const rows = await fetchTable(token, TABLES[name], MAPS[name] || {});
        return cors({ ok: true, data: rows, ts: Date.now() }, 200, origin);
      }

      // Health check
      if (url.pathname === "/") {
        return cors({ ok: true, service: "N7R OPS Worker v4", tables: Object.keys(TABLES) }, 200, origin);
      }

      return cors({ ok: false, error: "not found" }, 404, origin);
    } catch (e) {
      return cors({ ok: false, error: e.message }, 500, origin);
    }
  }
};

// ════════════════════════════════════════════════════════
// Feishu auth
// ════════════════════════════════════════════════════════
async function getToken(env) {
  const resp = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id:     env.FEISHU_APP_ID     || "cli_a922cf9adef8dbc6",
      app_secret: env.FEISHU_APP_SECRET || "GJz3kXbHMoxOkyotIQC61eJnB6lAQoGG",
    }),
  });
  const d = await resp.json();
  if (!d.tenant_access_token) throw new Error("飞书鉴权失败: " + JSON.stringify(d));
  return d.tenant_access_token;
}

// ════════════════════════════════════════════════════════
// Fetch table with field mapping
// ════════════════════════════════════════════════════════
async function fetchTable(token, tableId, fieldMap) {
  if (!tableId || tableId.startsWith("YOUR_TABLE_ID")) return [];
  const rows = [];
  let pageToken = "", hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({ page_size: "500" });
    if (pageToken) params.set("page_token", pageToken);
    const resp = await fetch(
      `${FEISHU_BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const d = await resp.json();
    if (d.code !== 0) throw new Error(`表 ${tableId}: ${d.msg}`);

    for (const rec of d.data?.items || []) {
      const row   = { _id: rec.record_id };
      const flds  = rec.fields || {};

      for (const [feishuKey, ourKey] of Object.entries(fieldMap)) {
        if (!(feishuKey in flds)) continue;       // skip missing
        if (row[ourKey] !== undefined) continue;  // first-match wins (handles aliases)
        let val = flds[feishuKey];
        val = coerce(val, ourKey);
        row[ourKey] = val;
      }
      rows.push(row);
    }
    hasMore   = d.data?.has_more || false;
    pageToken = d.data?.page_token || "";
  }
  return rows;
}

// ════════════════════════════════════════════════════════
// Fetch raw (no mapping) — for debug
// ════════════════════════════════════════════════════════
async function fetchRaw(token, tableId) {
  if (!tableId || tableId.startsWith("YOUR_TABLE_ID")) return [];
  const params = new URLSearchParams({ page_size: "10" });
  const resp = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = await resp.json();
  if (d.code !== 0) return [{ error: d.msg }];
  return (d.data?.items || []).map(r => r.fields);
}

function extractAllKeys(rows) {
  const keys = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => keys.add(k)));
  return [...keys];
}

// ════════════════════════════════════════════════════════
// Type coercion
// ════════════════════════════════════════════════════════
function coerce(val, key) {
  if (val === null || val === undefined) return null;

  // Array (multi-select / linked records)
  if (Array.isArray(val)) {
    return val.map(v => (v && v.text != null) ? v.text : String(v)).join(", ");
  }
  // Object with .text (single-select, formula, etc.)
  if (typeof val === "object" && val.text !== undefined) return val.text;
  // Object with .value (currency / number field variant)
  if (typeof val === "object" && val.value !== undefined) return val.value;

  // Timestamp → date string
  if (typeof val === "number" && val > 1_000_000_000_000 &&
      (key.includes("date") || key.includes("Date") || key === "date")) {
    return new Date(val).toISOString().slice(0, 10);
  }

  return val;
}

// ════════════════════════════════════════════════════════
// CORS
// ════════════════════════════════════════════════════════
function cors(body, status, origin) {
  return new Response(body !== null ? JSON.stringify(body) : null, {
    status,
    headers: {
      "Content-Type":                 "application/json",
      "Access-Control-Allow-Origin":  origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Cache-Control":                "no-cache",
    },
  });
}
