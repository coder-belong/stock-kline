/** 本地模拟账户的接口（后端 backend/paper.py） */
export type Position = {
  symbol: string; qty: number; avg_cost: number; last: number | null;
  market_value: number | null; pnl: number | null; pnl_pct: number | null;
};
export type Account = {
  day_pnl: number; day_pnl_pct: number; created_at: string;
  cash: number; reserved: number; available: number; initial_cash: number; market_value: number;
  equity: number; pnl: number; pnl_pct: number; positions: Position[]; max_order_value: number;
};
export type Order = {
  id: number; symbol: string; side: "buy" | "sell"; type: "market" | "limit"; qty: number;
  limit_price: number | null; status: "pending" | "filled" | "cancelled" | "rejected";
  fill_price: number | null; reason: string | null; created_at: string; filled_at: string | null;
};
export type OrderIn = { symbol: string; side: "buy" | "sell"; type: "market" | "limit"; qty: number; limit_price?: number };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const b = await res.json();
      if (b?.detail) msg = typeof b.detail === "string" ? b.detail : b.detail.map((d: { msg: string }) => d.msg).join("；");
    } catch { /* 用默认文案 */ }
    throw new Error(msg);
  }
  return res.json();
}

export const paper = {
  account: () => call<Account>("/api/paper/account"),
  orders: () => call<Order[]>("/api/paper/orders"),
  quote: (symbol: string) => call<{ symbol: string; last: number }>(`/api/paper/quote?symbol=${encodeURIComponent(symbol)}`),
  place: (o: OrderIn) => call<Order>("/api/paper/orders", { method: "POST", body: JSON.stringify(o) }),
  cancel: (id: number) => call<Order>(`/api/paper/orders/${id}/cancel`, { method: "POST" }),
  equity: () => call<{ time: number; equity: number }[]>("/api/paper/equity"),
  reset: (initial_cash: number) => call<Account>("/api/paper/reset", { method: "POST", body: JSON.stringify({ initial_cash }) }),
};

export const money = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
