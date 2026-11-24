"use client";

import { useEffect, useRef, useState } from "react";
import { api, num, pct, type Quote, type SearchItem } from "@/lib/api";
import type { Tick } from "@/lib/live";

export type Item = { symbol: string; name: string };

/** 迷你走势：近一个月收盘价 */
function Spark({ data, tone }: { data: number[]; tone: string }) {
  if (data.length < 2) return <svg className="spark" />;
  const min = Math.min(...data), max = Math.max(...data), w = 64, h = 24;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - ((v - min) / (max - min || 1)) * (h - 4)}`).join(" ");
  return (
    <svg className={"spark " + tone} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** 搜索框：输入时联想，回车直接看输入的代码；按 / 聚焦 */
function SearchBox({ onPick }: { onPick: (s: SearchItem | string) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const k = q.trim();
    if (!k) { setItems([]); return; }
    let alive = true;
    const t = setTimeout(() => api.search(k).then(r => { if (alive) { setItems(r); setActive(0); } }).catch(() => alive && setItems([])), 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  const pick = (it: SearchItem | string) => { onPick(it); setQ(""); setItems([]); setOpen(false); input.current?.blur(); };

  return (
    <div className="search">
      <span className="ico">⌕</span>
      <input ref={input} value={q} placeholder="搜代码或公司名  /" onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, items.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && q.trim()) pick(items[active] ?? q.trim().toUpperCase());
          else if (e.key === "Escape") { setQ(""); input.current?.blur(); }
        }} />
      {open && items.length > 0 && (
        <ul className="suggest">
          {items.map((it, i) => (
            <li key={it.symbol} className={i === active ? "on" : ""} onMouseEnter={() => setActive(i)} onMouseDown={() => pick(it)}>
              <b>{it.symbol}</b><span>{it.name}</span><em>{it.type} · {it.exchange}</em>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Sidebar({ list, current, quotes, sparks, tone, market, live, ticks, onPick, onRemove, onReset, actions, extra }: {
  list: Item[]; current: string; quotes: Record<string, Quote | null>; sparks: Record<string, number[]>;
  tone: (x: number | null | undefined) => string; market: Quote | null; live: string; ticks: Record<string, Tick>;
  onPick: (s: SearchItem | string) => void; onRemove: (s: string) => void; onReset: () => void; actions: React.ReactNode; extra?: React.ReactNode;
}) {
  return (
    <aside className="side">
      <div className="brand">
        <span className="logo">K</span>
        <div><b>美股行情</b><span>模拟交易</span></div>
        <div className="brand-act">{actions}</div>
      </div>
      {market && <div className={"mkt " + market.market}><i />{market.market_label}<span className={"lv " + live}>{live === "connected" ? "● 实时推送" : live === "connecting" ? "○ 连接中" : "○ 已断开"}</span></div>}
      {extra}
      <SearchBox onPick={onPick} />
      <div className="list-hd"><span>自选</span><span>最新价 / 今日</span></div>
      <ul className="list">
        {list.map(it => {
          const q = quotes[it.symbol];
          const t = tone(q?.change_pct);
          return (
            <li key={it.symbol} className={it.symbol === current ? "on" : ""} onClick={() => onPick(it.symbol)}>
              <div className="nm">
                <b>{it.symbol}</b><span>{it.name || q?.name || ""}</span>
                {ticks[it.symbol] && ticks[it.symbol].session !== "regular" && q && (
                  <small className={tone(ticks[it.symbol].price - q.last)}>{ticks[it.symbol].session_label} {num(ticks[it.symbol].price)}</small>
                )}
              </div>
              <Spark data={sparks[it.symbol] ?? []} tone={t} />
              <div className="px">
                <b key={q?.last} className="tick">{q ? num(q.last) : "…"}</b>
                <em className={"pill " + t}>{q?.change_pct != null ? pct(q.change_pct) : "—"}</em>
              </div>
              <button className="x" title="移出自选" onClick={e => { e.stopPropagation(); onRemove(it.symbol); }}>×</button>
            </li>
          );
        })}
      </ul>
      <button className="link" onClick={onReset}>恢复默认自选</button>
    </aside>
  );
}
