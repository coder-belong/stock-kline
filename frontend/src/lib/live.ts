"use client";

import { useEffect, useRef, useState } from "react";

/** 后端 /api/ws 推来的一笔价格（backend/live.py 的 to_tick） */
export type Tick = {
  type: "tick"; symbol: string; price: number; change: number | null; change_pct: number | null;
  session: "pre" | "regular" | "post" | "overnight"; session_label: string;
  day_volume: number | null; day_high: number | null; day_low: number | null;
  et_day: string; et_secs: number; et_time: string;
};
export type LiveStatus = "idle" | "connecting" | "connected" | "error" | "offline";

/**
 * 浏览器直接连后端的 WebSocket（Next 的 rewrites 不转发 WebSocket，所以不走 /api 代理）。
 * 断线自动重连；订阅列表变了就重发一次完整列表。价格推得很密，攒 250ms 再更新一次界面。
 */
export function useLive(symbols: string[]) {
  const [ticks, setTicks] = useState<Record<string, Tick>>({});
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const ws = useRef<WebSocket | null>(null);
  const want = useRef<string[]>(symbols);
  const pending = useRef<Record<string, Tick>>({});

  const key = [...new Set(symbols)].sort().join(",");
  useEffect(() => {
    want.current = key ? key.split(",") : [];
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "subscribe", symbols: want.current }));
  }, [key]);

  useEffect(() => {
    let stop = false, retry = 1000, timer: ReturnType<typeof setTimeout> | undefined;
    const url = process.env.NEXT_PUBLIC_WS_URL || `ws://${location.hostname}:8090/api/ws`;
    const flush = setInterval(() => {
      const p = pending.current;
      if (Object.keys(p).length) { pending.current = {}; setTicks(t => ({ ...t, ...p })); }
    }, 250);

    const connect = () => {
      if (stop) return;
      setStatus("connecting");
      const s = new WebSocket(url);
      ws.current = s;
      s.onopen = () => { retry = 1000; s.send(JSON.stringify({ type: "subscribe", symbols: want.current })); };
      s.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.type === "tick") pending.current[m.symbol] = m;
        else if (m.type === "status") setStatus(m.upstream === "idle" ? "connecting" : m.upstream);
      };
      s.onclose = () => {
        if (stop) return;
        setStatus("offline");
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
      s.onerror = () => s.close();
    };
    connect();
    return () => { stop = true; clearTimeout(timer); clearInterval(flush); ws.current?.close(); };
  }, []);

  return { ticks, status };
}
