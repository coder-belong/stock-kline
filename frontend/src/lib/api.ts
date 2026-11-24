/** 行情接口（后端 backend/main.py）+ 均线、区间统计这些纯计算 */

/** 日 K 的 time 是 "YYYY-MM-DD"；分时是秒数（美东钟点当成 UTC，直接显示就是美东时间） */
export type Bar = { time: string | number; open: number; high: number; low: number; close: number; volume: number };
export type Kline = { symbol: string; range: string; intraday: boolean; bars: Bar[]; fetched_at: number };
export type Quote = {
  symbol: string; name: string | null; currency: string | null; last: number;
  prev_close: number | null; change: number | null; change_pct: number | null;
  open: number; high: number; low: number; volume: number; day: string; asset: string;
  market: "pre" | "open" | "post" | "closed"; market_label: string; et_now: string;
};
export type SearchItem = { symbol: string; name: string; type: string; exchange: string };

export type RangeKey = "1d" | "5d" | "1mo" | "3mo" | "6mo" | "1y" | "3y" | "5y";
export const RANGES: { key: RangeKey; label: string }[] = [
  { key: "1d", label: "1 日" },
  { key: "5d", label: "5 日" },
  { key: "1mo", label: "1 月" },
  { key: "3mo", label: "3 月" },
  { key: "6mo", label: "6 月" },
  { key: "1y", label: "1 年" },
  { key: "3y", label: "3 年" },
  { key: "5y", label: "5 年" },
];
export const isIntraday = (r: RangeKey) => r === "1d" || r === "5d";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const b = await res.json();
      if (b?.detail) msg = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch { /* 用默认文案 */ }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  kline: (symbol: string, range: RangeKey) => get<Kline>(`/api/kline?symbol=${encodeURIComponent(symbol)}&range=${range}`),
  quote: (symbol: string) => get<Quote>(`/api/quote?symbol=${encodeURIComponent(symbol)}`),
  search: (q: string) => get<SearchItem[]>(`/api/search?q=${encodeURIComponent(q)}`),
};

/** n 根均线；不足 n 根的不画 */
export function movingAverage(bars: Bar[], n: number) {
  const out: { time: Bar["time"]; value: number }[] = [];
  let sum = 0;
  bars.forEach((b, i) => {
    sum += b.close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: b.time, value: +(sum / n).toFixed(4) });
  });
  return out;
}

/** 区间统计：涨跌幅（区间第一根开盘 → 最后收盘）、最高最低、最大回撤（按收盘） */
export function stats(bars: Bar[]) {
  if (!bars.length) return null;
  const first = bars[0].open, last = bars[bars.length - 1].close;
  let high = -Infinity, low = Infinity, highAt: Bar["time"] = "", lowAt: Bar["time"] = "";
  let peak = -Infinity, maxDd = 0;
  for (const b of bars) {
    if (b.high > high) { high = b.high; highAt = b.time; }
    if (b.low < low) { low = b.low; lowAt = b.time; }
    peak = Math.max(peak, b.close);
    maxDd = Math.min(maxDd, (b.close - peak) / peak);
  }
  return { rangeChange: (last - first) / first, high, highAt, low, lowAt, maxDrawdown: maxDd };
}

/** 显示时间：日 K 原样，分时转 "MM-DD HH:mm"（秒数按 UTC 解释就是美东钟点） */
export function fmtTime(t: Bar["time"]) {
  if (typeof t === "string") return t;
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export const pct = (x: number) => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
export const num = (x: number, d = 2) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export function fmtVol(v: number) {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + " 亿";
  if (v >= 1e4) return (v / 1e4).toFixed(0) + " 万";
  return String(v);
}

/** 浏览器里存设置；读写失败（隐私模式等）就用默认值 */
const LS = "stock-kline:v2";
export function load<T>(k: string, d: T): T {
  try { const v = JSON.parse(localStorage.getItem(LS) || "{}")[k]; return v ?? d; } catch { return d; }
}
export function store(k: string, v: unknown) {
  try { const all = JSON.parse(localStorage.getItem(LS) || "{}"); all[k] = v; localStorage.setItem(LS, JSON.stringify(all)); } catch { /* 存不了就算了 */ }
}
