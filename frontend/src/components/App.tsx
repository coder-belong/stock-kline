"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Chart, { type ChartMode } from "./Chart";
import Sidebar, { type Item } from "./Sidebar";
import { LoginDialog, ThemeToggle, UpDownToggle, UserMenu } from "./Account";
import Assets, { AssetCard } from "./Assets";
import { Portfolio, TradePanel } from "./Trade";
import {
  RANGES, api, fmtTime, fmtVol, isIntraday, load, num, pct, stats, store,
  type Kline, type Quote, type RangeKey, type SearchItem,
} from "@/lib/api";
import { auth, type User } from "@/lib/auth";
import { useLive, type Tick } from "@/lib/live";
import { paper, type Account, type Order } from "@/lib/paper";

const DEFAULT_LIST: Item[] = [
  { symbol: "^GSPC", name: "标普 500" },
  { symbol: "^IXIC", name: "纳斯达克综合" },
  { symbol: "^DJI", name: "道琼斯" },
  { symbol: "SPY", name: "标普 500 ETF" },
  { symbol: "QQQ", name: "纳指 100 ETF" },
  { symbol: "NVDA", name: "英伟达" },
  { symbol: "AAPL", name: "苹果" },
  { symbol: "MSFT", name: "微软" },
  { symbol: "GOOGL", name: "谷歌" },
  { symbol: "MU", name: "美光科技" },
  { symbol: "TSLA", name: "特斯拉" },
];

export default function App() {
  const [list, setList] = useState<Item[]>(() => load("list", DEFAULT_LIST));
  const [symbol, setSymbol] = useState<string>(() => load("symbol", "NVDA"));
  const [range, setRange] = useState<RangeKey>(() => load("range", "5d"));
  const [modes, setModes] = useState<{ intraday: ChartMode; daily: ChartMode }>(() => load("modes", { intraday: "line", daily: "candle" }));
  const [showMA, setShowMA] = useState<boolean>(() => load("showMA", true));
  const [showVol, setShowVol] = useState<boolean>(() => load("showVol", true));
  const [upRed, setUpRed] = useState<boolean>(() => load("upRed", true));
  const [theme, setTheme] = useState<"auto" | "light" | "dark">(() => load("theme", "auto"));
  const [sysDark, setSysDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => store("list", list), [list]);
  useEffect(() => store("symbol", symbol), [symbol]);
  useEffect(() => store("range", range), [range]);
  useEffect(() => store("modes", modes), [modes]);
  useEffect(() => store("showMA", showMA), [showMA]);
  useEffect(() => store("showVol", showVol), [showVol]);
  useEffect(() => store("upRed", upRed), [upRed]);
  useEffect(() => store("theme", theme), [theme]);
  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: dark)");
    const f = () => setSysDark(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  const dark = theme === "dark" || (theme === "auto" && sysDark);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);

  /** 点太阳 / 月亮：浅深互换；新主题从按钮处画圆铺开 */
  const toggleTheme = (x: number, y: number) => {
    const next = dark ? "light" : "dark";
    const apply = () => flushSync(() => { document.documentElement.dataset.theme = next; setTheme(next); });
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
    if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return apply();
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    doc.startViewTransition(apply).ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 550, easing: "cubic-bezier(.4,0,.2,1)", pseudoElement: "::view-transition-new(root)" },
      );
    });
  };

  // ---- 账号：登录后自选和模拟账户跟着账号走 ----
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [view, setView] = useState<"market" | "assets">("market");
  const listSynced = useRef(false);  // 服务器上的自选拉下来之前不往回写，免得把账号里的覆盖掉
  useEffect(() => { auth.me().then(setUser).catch(() => setUser(null)).finally(() => setAuthChecked(true)); }, []);
  useEffect(() => {
    listSynced.current = false;
    if (!user) return;
    auth.getWatchlist().then(srv => {
      if (srv && srv.length) setList(srv);
      else auth.putWatchlist(list).catch(() => {});  // 新账号：把本机的自选传上去
      listSynced.current = true;
    }).catch(() => { listSynced.current = true; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  useEffect(() => {
    if (!user || !listSynced.current) return;
    const t = setTimeout(() => auth.putWatchlist(list).catch(() => {}), 500);
    return () => clearTimeout(t);
  }, [list, user]);

  const intraday = isIntraday(range);
  const mode = intraday ? modes.intraday : modes.daily;
  const tone = useCallback((x: number | null | undefined) => (x == null || x === 0 ? "" : (x > 0) === upRed ? "up" : "down"), [upRed]);

  // ---- 主图 K 线：分时每分钟刷新一次 ----
  const [kline, setKline] = useState<Kline | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const loadKline = useCallback((quiet = false) => {
    let alive = true;
    if (!quiet) { setLoading(true); setErr(""); }
    api.kline(symbol, range)
      .then(d => { if (alive) { setKline(d); setErr(""); setUpdatedAt(new Date()); } })
      .catch(e => { if (alive && !quiet) { setErr(String(e.message || e)); setKline(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [symbol, range]);
  useEffect(() => {
    const stop = loadKline();
    const t = intraday ? setInterval(() => loadKline(true), 60_000) : undefined;
    return () => { stop(); if (t) clearInterval(t); };
  }, [loadKline, intraday]);

  // ---- 当前代码的报价：30 秒刷新 ----
  const [quote, setQuote] = useState<Quote | null>(null);
  useEffect(() => {
    let alive = true;
    setQuote(null);
    const go = () => api.quote(symbol).then(q => alive && setQuote(q)).catch(() => {});
    go();
    const t = setInterval(go, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol]);

  // ---- 自选：每个代码的报价（1 分钟刷新）和近一个月走势 ----
  const [quotes, setQuotes] = useState<Record<string, Quote | null>>({});
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const listKey = list.map(i => i.symbol).join(",");
  useEffect(() => {
    let alive = true;
    const go = () => list.forEach(it => api.quote(it.symbol).then(q => alive && setQuotes(m => ({ ...m, [it.symbol]: q }))).catch(() => alive && setQuotes(m => ({ ...m, [it.symbol]: null }))));
    go();
    list.forEach(it => api.kline(it.symbol, "1mo").then(k => alive && setSparks(m => ({ ...m, [it.symbol]: k.bars.map(b => b.close) }))).catch(() => {}));
    const t = setInterval(go, 60_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);

  // ---- 模拟账户 ----
  const [account, setAccount] = useState<Account | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [toast, setToast] = useState("");
  const refreshPaper = useCallback(() => {
    if (!user) { setAccount(null); setOrders([]); return; }
    paper.account().then(setAccount).catch(() => {});
    paper.orders().then(setOrders).catch(() => {});
  }, [user]);
  useEffect(() => {
    refreshPaper();
    if (!user) return;
    const t = setInterval(refreshPaper, 15_000);
    return () => clearInterval(t);
  }, [refreshPaper, user]);
  const logout = () => auth.logout().finally(() => { setUser(null); setView("market"); notify("已退出登录"); });
  const notify = (msg: string) => { setToast(msg); refreshPaper(); setTimeout(() => setToast(t => (t === msg ? "" : t)), 4000); };
  const cancelOrder = (id: number) => paper.cancel(id).then(() => notify("已撤单")).catch(e => notify(e.message));
  const resetPaper = () => {
    const v = prompt("重置模拟账户：清空持仓和委托。初始资金（美元）", "100000");
    if (v === null) return;
    const n = Number(v);
    if (!(n > 0)) return notify("初始资金要大于 0");
    paper.reset(n).then(() => notify(`已重置，初始资金 ${n.toLocaleString()}`)).catch(e => notify(e.message));
  };

  // ---- 实时推送：自选 + 当前代码 ----
  const { ticks, status: liveStatus } = useLive(useMemo(() => [...list.map(i => i.symbol), symbol], [list, symbol]));
  /** 盘中的推送覆盖报价；盘前 / 盘后 / 夜盘的单独显示，不改正式收盘价 */
  const merge = useCallback((q: Quote | null | undefined, t: Tick | undefined): Quote | null => {
    if (!q) return q ?? null;
    if (!t || t.session !== "regular") return q;
    // 盘中推送就是最新的；日期不比（加密货币的日线按 UTC 切日，和美东日期会差一天）
    return { ...q, last: t.price, change: t.change ?? q.change, change_pct: t.change_pct ?? q.change_pct,
      high: Math.max(q.high, t.day_high ?? t.price), low: Math.min(q.low, t.day_low ?? t.price),
      volume: t.day_volume ?? q.volume };
  }, []);
  const liveQuote = merge(quote, ticks[symbol]);
  const liveQuotes = useMemo(() => Object.fromEntries(list.map(i => [i.symbol, merge(quotes[i.symbol], ticks[i.symbol])])), [list, quotes, ticks, merge]);
  const ext = ticks[symbol] && ticks[symbol].session !== "regular" ? ticks[symbol] : null;

  // 盘中推送顺手更新最后一根 K 线（分时按 5 / 15 分钟分桶，超出就新开一根）
  const bars = useMemo(() => {
    const t = kline && ticks[kline.symbol];
    if (!kline || !t || t.session !== "regular" || !kline.bars.length) return kline?.bars ?? [];
    const bs = kline.bars, last = bs[bs.length - 1];
    if (kline.intraday) {
      const step = kline.range === "1d" ? 300 : 900, slot = Math.floor(t.et_secs / step) * step;
      if (typeof last.time !== "number" || slot < last.time) return bs;
      if (slot === last.time) return [...bs.slice(0, -1), { ...last, close: t.price, high: Math.max(last.high, t.price), low: Math.min(last.low, t.price) }];
      return [...bs, { time: slot, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0 }];
    }
    if (t.et_day === last.time) return [...bs.slice(0, -1), { ...last, close: t.price, high: Math.max(last.high, t.price), low: Math.min(last.low, t.price) }];
    if (t.et_day > String(last.time)) return [...bs, { time: t.et_day, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0 }];
    return bs;
  }, [kline, ticks]);

  // 价格跳动时闪一下
  const prevPrice = useRef<number | null>(null);
  const [flash, setFlash] = useState("");
  useEffect(() => {
    const p = liveQuote?.last ?? null, old = prevPrice.current;
    prevPrice.current = p;
    if (p == null || old == null || p === old) return;
    setFlash(p > old === upRed ? "flash-up" : "flash-down");
    const t = setTimeout(() => setFlash(""), 600);
    return () => clearTimeout(t);
  }, [liveQuote?.last, upRed]);
  useEffect(() => { prevPrice.current = null; }, [symbol]);

  const pick = (it: SearchItem | string) => {
    setView("market");
    if (typeof it === "string") return setSymbol(it.toUpperCase());
    setSymbol(it.symbol);
  };
  const inList = list.some(i => i.symbol === symbol);
  const toggleList = () => setList(l => (inList ? l.filter(i => i.symbol !== symbol) : [...l, { symbol, name: quote?.name ?? "" }]));
  const name = list.find(i => i.symbol === symbol)?.name || quote?.name || "";
  const st = useMemo(() => (bars.length ? stats(bars) : null), [bars]);
  const rangeLabel = RANGES.find(r => r.key === range)?.label;

  return (
    <div className="app">
      <Sidebar extra={user && account ? <AssetCard account={account} tone={tone} active={view === "assets"} onOpen={() => setView("assets")} /> : null}
        list={list} current={symbol} quotes={liveQuotes} sparks={sparks} tone={tone} market={quote} live={liveStatus} ticks={ticks}
        onPick={pick} onRemove={s => setList(l => l.filter(x => x.symbol !== s))} onReset={() => setList(DEFAULT_LIST)}
        actions={<>
          <ThemeToggle dark={dark} onToggle={toggleTheme} />
          <UpDownToggle upRed={upRed} onToggle={() => setUpRed(v => !v)} />
          {authChecked && <UserMenu user={user} onLogin={() => setShowLogin(true)} onLogout={logout} />}
        </>} />

      <main className="main">
        {user && (
          <div className="views">
            <button className={view === "market" ? "on" : ""} onClick={() => setView("market")}>行情</button>
            <button className={view === "assets" ? "on" : ""} onClick={() => setView("assets")}>我的资产</button>
          </div>
        )}
        {view === "assets" && user ? (
          <Assets account={account} orders={orders} tone={tone} dark={dark}
            onPick={s => { setSymbol(s); setView("market"); }} onCancel={cancelOrder} onReset={resetPaper} />
        ) : <>
        {/* 报价头 */}
        <section className="quote card">
          <div className="q-left">
            <div className="q-title">
              <h1>{symbol}</h1>
              <span className="name">{name}</span>
              <button className={"star" + (inList ? " on" : "")} onClick={toggleList} title={inList ? "移出自选" : "加入自选"}>{inList ? "★ 已自选" : "☆ 加自选"}</button>
            </div>
            {liveQuote ? (
              <div className="q-price">
                <b className={tone(liveQuote.change) + " " + flash}>{num(liveQuote.last)}</b>
                {liveQuote.change != null && <span className={tone(liveQuote.change)}>{liveQuote.change >= 0 ? "+" : ""}{num(liveQuote.change)}</span>}
                {liveQuote.change_pct != null && <span className={"pill " + tone(liveQuote.change_pct)}>{pct(liveQuote.change_pct)}</span>}
                <em>{liveQuote.day}{liveQuote.asset === "crypto" ? " UTC" : " 美东"} · {liveQuote.market_label}</em>
                <LiveBadge status={liveStatus} tick={ticks[symbol]} />
              </div>
            ) : <div className="q-price skel" />}
            {ext && liveQuote && (
              <div className="q-ext">
                <span className="tag-s">{ext.session_label}</span>
                <b className={tone(ext.price - liveQuote.last)}>{num(ext.price)}</b>
                <span className={tone(ext.price - liveQuote.last)}>{ext.price - liveQuote.last >= 0 ? "+" : ""}{num(ext.price - liveQuote.last)}（{pct((ext.price - liveQuote.last) / liveQuote.last)}）</span>
                <em>美东 {ext.et_time}</em>
              </div>
            )}
          </div>
          {liveQuote && (
            <dl className="q-grid">
              <dt>今开</dt><dd>{num(liveQuote.open)}</dd>
              <dt>最高</dt><dd className={tone(liveQuote.prev_close != null ? liveQuote.high - liveQuote.prev_close : null)}>{num(liveQuote.high)}</dd>
              <dt>最低</dt><dd className={tone(liveQuote.prev_close != null ? liveQuote.low - liveQuote.prev_close : null)}>{num(liveQuote.low)}</dd>
              <dt>昨收</dt><dd>{liveQuote.prev_close != null ? num(liveQuote.prev_close) : "—"}</dd>
              <dt>成交量</dt><dd>{fmtVol(liveQuote.volume)}</dd>
              <dt>振幅</dt><dd>{liveQuote.prev_close ? pct((liveQuote.high - liveQuote.low) / liveQuote.prev_close).replace("+", "") : "—"}</dd>
            </dl>
          )}
        </section>

        <div className="work">
          <div className="work-main">
            <section className="card chart-card">
              {/* 工具栏 */}
              <div className="toolbar">
                <div className="seg">
                  {RANGES.map(r => <button key={r.key} className={r.key === range ? "on" : ""} onClick={() => setRange(r.key)}>{r.label}</button>)}
                </div>
                <div className="tb-right">
                  <div className="seg">
                    <button className={mode === "line" ? "on" : ""} onClick={() => setModes(m => ({ ...m, [intraday ? "intraday" : "daily"]: "line" }))}>分时</button>
                    <button className={mode === "candle" ? "on" : ""} onClick={() => setModes(m => ({ ...m, [intraday ? "intraday" : "daily"]: "candle" }))}>K 线</button>
                  </div>
                  <label className={"chk" + (mode !== "candle" ? " off" : "")}><input type="checkbox" checked={showMA} disabled={mode !== "candle"} onChange={e => setShowMA(e.target.checked)} />均线</label>
                  <label className="chk"><input type="checkbox" checked={showVol} onChange={e => setShowVol(e.target.checked)} />成交量</label>
                  <button className="icon" title="刷新" onClick={() => loadKline()} disabled={loading}>{loading ? "…" : "↻"}</button>
                </div>
              </div>

              {/* 区间统计 */}
              {st && (
                <div className="rstats">
                  <span>{range === "1d" ? "开盘以来" : `${rangeLabel}涨跌`} <b className={tone(st.rangeChange)}>{pct(st.rangeChange)}</b></span>
                  <span>最高 <b>{num(st.high)}</b> <em>{fmtTime(st.highAt)}</em></span>
                  <span>最低 <b>{num(st.low)}</b> <em>{fmtTime(st.lowAt)}</em></span>
                  <span>最大回撤 <b className={tone(st.maxDrawdown)}>{pct(st.maxDrawdown)}</b></span>
                  <span className="muted">{intraday ? (range === "1d" ? "5 分钟一根" : "15 分钟一根") : "日 K"} · {bars.length} 根</span>
                </div>
              )}

              {err && <div className="err">{err}</div>}
              {kline && (
                <Chart bars={bars} fitKey={`${kline.symbol}|${kline.range}`} intraday={intraday} mode={mode} showMA={showMA} showVol={showVol} upRed={upRed} dark={dark}
                  baseline={range === "1d" ? quote?.prev_close ?? null : null} />
              )}
              {!kline && !err && <div className="empty">加载中…</div>}
            </section>
          </div>
          {user ? <TradePanel symbol={symbol} account={account} color={tone} onDone={notify} /> : (
            <aside className="trade">
              <div className="acct guest">
                <div className="guest-ico">¥</div>
                <b>模拟交易</b>
                <p>登录后领取 10 万美元虚拟资金，买卖美股练手。账户和自选都保存在账号下。</p>
                <button className="submit primary" onClick={() => setShowLogin(true)}>登录 / 注册</button>
              </div>
            </aside>
          )}
        </div>

        {user && <Portfolio account={account} orders={orders} color={tone} onPick={setSymbol} onCancel={cancelOrder} onReset={resetPaper} />}
        </>}
        {showLogin && <LoginDialog onClose={() => setShowLogin(false)} onDone={u => { setUser(u); setShowLogin(false); notify(`欢迎，${u.username}`); }} />}

        <footer className="foot">
          数据来自 Yahoo Finance（yfinance，非官方接口），有延迟，仅供自己看，不构成投资建议。时间均为美东时间。
          {updatedAt && <> · 图表更新于 {updatedAt.toLocaleTimeString("zh-CN", { hour12: false })}{intraday ? "（分时每分钟自动刷新）" : ""}</>}
        </footer>
        {toast && <div className="toast">{toast}</div>}
      </main>
    </div>
  );
}

/** 实时连接状态 + 最近一笔推送的时间 */
function LiveBadge({ status, tick }: { status: string; tick?: Tick }) {
  const label = status === "connected" ? (tick ? `实时 ${tick.et_time}` : "实时已连接") : status === "connecting" ? "实时连接中" : "实时已断开，重连中";
  return <span className={"live " + status}><i />{label}</span>;
}
