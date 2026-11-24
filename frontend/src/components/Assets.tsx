"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ColorType, createChart, type IChartApi, type ISeriesApi, type Time } from "lightweight-charts";
import { fmtTime, pct } from "@/lib/api";
import { money, paper, type Account, type Order } from "@/lib/paper";
import { Portfolio } from "./Trade";

type ColorFn = (x: number | null | undefined) => string;
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const sign = (x: number) => (x >= 0 ? "+" : "−") + money(Math.abs(x));
/** 分布图配色：现金灰，持仓用一组和靛紫主色搭的颜色 */
const PALETTE = ["#6366f1", "#8b5cf6", "#06b6d4", "#f59e0b", "#ec4899", "#10b981", "#3b82f6", "#f97316", "#14b8a6", "#a855f7"];

/** 侧栏里的总资产小卡片，点了进「我的资产」 */
export function AssetCard({ account, tone, active, onOpen }: { account: Account; tone: ColorFn; active: boolean; onOpen: () => void }) {
  return (
    <button className={"asset-card" + (active ? " on" : "")} onClick={onOpen}>
      <div className="ac-hd"><span>总资产（USD）</span><em>我的资产 ›</em></div>
      <b>{money(account.equity)}</b>
      <div className="ac-row">
        <span>今日 <i className={tone(account.day_pnl)}>{sign(account.day_pnl)}</i></span>
        <span>累计 <i className={tone(account.pnl)}>{pct(account.pnl_pct)}</i></span>
      </div>
    </button>
  );
}

/** 总资产走势 */
function EquityChart({ points, tone, dark }: { points: { time: number; equity: number }[]; tone: string; dark: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Area"> | null>(null);
  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      handleScroll: false, handleScale: false, localization: { locale: "zh-CN", timeFormatter: (t: Time) => fmtTime(t as number) },
    });
    series.current = c.addAreaSeries({
      lineWidth: 2, priceLineVisible: false, priceFormat: { type: "price", precision: 0, minMove: 1 },
      // 总资产变化很小时（比如刚开户一条平线），纵轴至少撑开 ±1%，不然会放大成 99,999.96 这种刻度
      autoscaleInfoProvider: (orig: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const r = orig();
        if (!r) return r;
        const { minValue, maxValue } = r.priceRange, mid = (minValue + maxValue) / 2, half = Math.max((maxValue - minValue) / 2, mid * 0.01);
        return { ...r, priceRange: { minValue: mid - half, maxValue: mid + half } };
      },
    });
    chart.current = c;
    return () => { c.remove(); chart.current = null; };
  }, []);
  useEffect(() => {
    const c = chart.current, s = series.current;
    if (!c || !s) return;
    const color = tone === "up" ? css("--up") : tone === "down" ? css("--down") : css("--acc");
    c.applyOptions({ layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--sub"), fontSize: 12 },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } } });
    s.applyOptions({ lineColor: color, topColor: color + "40", bottomColor: color + "05" });
    s.setData(points.map(p => ({ time: p.time as Time, value: p.equity })));
    c.timeScale().fitContent();
  }, [points, tone, dark]);
  return <div ref={box} className="eq-chart" />;
}

/** 资产分布：环形图 + 图例 */
function Allocation({ account }: { account: Account }) {
  const parts = useMemo(() => {
    const ps = account.positions.map((p, i) => ({ name: p.symbol, value: p.market_value ?? p.qty * p.avg_cost, color: PALETTE[i % PALETTE.length] }))
      .sort((a, b) => b.value - a.value);
    return [...ps, { name: "现金", value: Math.max(account.cash, 0), color: "var(--faint)" }].filter(p => p.value > 0);
  }, [account]);
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const R = 54, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="alloc">
      <svg viewBox="0 0 140 140" className="donut">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--hover)" strokeWidth="16" />
        {parts.map(p => {
          const len = (p.value / total) * C, off = acc;
          acc += len;
          return <circle key={p.name} cx="70" cy="70" r={R} fill="none" stroke={p.color} strokeWidth="16"
            strokeDasharray={`${Math.max(len - 1.5, 0)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 70 70)" className="seg-arc" />;
        })}
        <text x="70" y="66" textAnchor="middle" className="d-t">持仓占比</text>
        <text x="70" y="84" textAnchor="middle" className="d-v">{((account.market_value / (account.equity || 1)) * 100).toFixed(1)}%</text>
      </svg>
      <ul className="legend-list">
        {parts.map(p => (
          <li key={p.name}><i style={{ background: p.color }} /><span>{p.name}</span><b>{((p.value / total) * 100).toFixed(1)}%</b><em>{money(p.value)}</em></li>
        ))}
      </ul>
    </div>
  );
}

export default function Assets({ account, orders, tone, dark, onPick, onCancel, onReset }: {
  account: Account | null; orders: Order[]; tone: ColorFn; dark: boolean;
  onPick: (s: string) => void; onCancel: (id: number) => void; onReset: () => void;
}) {
  const [points, setPoints] = useState<{ time: number; equity: number }[]>([]);
  useEffect(() => {
    let alive = true;
    const go = () => paper.equity().then(p => alive && setPoints(p)).catch(() => {});
    go();
    const t = setInterval(go, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [account?.equity]);

  if (!account) return <div className="empty">加载中…</div>;
  // 曲线最后补一个「现在」的点，让曲线跟上实时总资产
  const nowEt = (() => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) / 1000); })();
  const curve = points.length && nowEt > points[points.length - 1].time ? [...points, { time: nowEt, equity: account.equity }] : points;
  const fills = orders.filter(o => o.status === "filled").length;
  const days = Math.max(1, Math.ceil((Date.now() - new Date(account.created_at).getTime()) / 86_400_000));

  return (
    <div className="assets">
      <section className="card a-hero">
        <div className="a-main">
          <span className="a-lbl">总资产（USD）</span>
          <b className="a-eq">{money(account.equity)}</b>
          <div className="a-sub">
            <span className={"pill " + tone(account.pnl)}>累计 {sign(account.pnl)}（{pct(account.pnl_pct)}）</span>
            <span className="muted">开户第 {days} 天 · 初始资金 {money(account.initial_cash)}</span>
          </div>
        </div>
        <div className="a-stats">
          <div><span>今日盈亏</span><b className={tone(account.day_pnl)}>{sign(account.day_pnl)}</b><em className={tone(account.day_pnl)}>{pct(account.day_pnl_pct)}</em></div>
          <div><span>持仓市值</span><b>{money(account.market_value)}</b><em>{account.positions.length} 只</em></div>
          <div><span>可用现金</span><b>{money(account.available)}</b><em>{account.reserved > 0 ? `挂单占用 ${money(account.reserved)}` : "可随时下单"}</em></div>
          <div><span>成交笔数</span><b>{fills}</b><em>全部委托 {orders.length}</em></div>
        </div>
      </section>

      <div className="a-grid">
        <section className="card a-box">
          <div className="a-box-hd"><b>资产走势</b><span className="muted">每 5 分钟记一次 · 美东时间</span></div>
          {curve.length >= 2 ? <EquityChart points={curve} tone={tone(account.pnl)} dark={dark} /> : <div className="none">数据还不够，用一会儿就有曲线了</div>}
        </section>
        <section className="card a-box">
          <div className="a-box-hd"><b>资产分布</b><span className="muted">按市值</span></div>
          <Allocation account={account} />
        </section>
      </div>

      <Portfolio account={account} orders={orders} color={tone} onPick={onPick} onCancel={onCancel} onReset={onReset} />
    </div>
  );
}
