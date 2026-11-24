"use client";

import { useEffect, useMemo, useState } from "react";
import { money, paper, type Account, type Order, type OrderIn } from "@/lib/paper";

const pct = (x: number) => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
const sign = (x: number) => (x >= 0 ? "+" : "") + money(x);

type ColorFn = (x: number) => string;

/** 右侧：账户概况 + 下单 */
export function TradePanel({ symbol, account, color, onDone }: {
  symbol: string; account: Account | null; color: ColorFn; onDone: (msg: string) => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState("10");
  const [limit, setLimit] = useState("");
  const [last, setLast] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<OrderIn | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    setLast(null); setErr("");
    paper.quote(symbol).then(q => { if (alive) { setLast(q.last); setLimit(q.last.toFixed(2)); } }).catch(e => alive && setErr(e.message));
    return () => { alive = false; };
  }, [symbol]);

  const pos = account?.positions.find(p => p.symbol === symbol);
  const n = Math.floor(Number(qty) || 0);
  const price = type === "limit" ? Number(limit) || 0 : last ?? 0;
  const amount = n * price;
  const maxBuy = account && price ? Math.floor(Math.min(account.available, account.max_order_value) / price) : 0;
  const problem = useMemo(() => {
    if (!n || n <= 0) return "数量要大于 0";
    if (type === "limit" && !(Number(limit) > 0)) return "请填限价";
    if (!account || !price) return "";
    if (amount > account.max_order_value) return `单笔金额上限 ${money(account.max_order_value)}`;
    if (side === "buy" && amount > account.available) return "可用现金不足";
    if (side === "sell" && n > (pos?.qty ?? 0)) return `可卖 ${pos?.qty ?? 0} 股`;
    return "";
  }, [n, type, limit, account, price, amount, side, pos]);

  const submit = async () => {
    if (!confirm) return;
    setBusy(true); setErr("");
    try {
      const o = await paper.place(confirm);
      const what = `${o.side === "buy" ? "买入" : "卖出"} ${o.symbol} ${o.qty} 股`;
      onDone(o.status === "filled" ? `${what}，成交价 ${money(o.fill_price!)}` : o.status === "pending" ? `${what}，限价 ${money(o.limit_price!)} 已挂单` : `${what} 被拒：${o.reason}`);
      setConfirm(null);
    } catch (e) {
      setErr((e as Error).message); setConfirm(null);
    } finally { setBusy(false); }
  };

  return (
    <aside className="trade">
      {account && (
        <div className="acct">
          <div className="acct-hd"><span>模拟账户 · 总资产</span><span className="tag">虚拟资金</span></div>
          <b className="eq">{money(account.equity)}</b>
          <div className={"pl " + color(account.pnl)}>{sign(account.pnl)}（{pct(account.pnl_pct)}）</div>
          <dl>
            <dt>可用现金</dt><dd>{money(account.available)}</dd>
            <dt>持仓市值</dt><dd>{money(account.market_value)}</dd>
            {account.reserved > 0 && <><dt>挂单占用</dt><dd>{money(account.reserved)}</dd></>}
          </dl>
        </div>
      )}

      <div className="order">
        <div className="seg full">
          <button className={side === "buy" ? "on buy" : ""} onClick={() => setSide("buy")}>买入</button>
          <button className={side === "sell" ? "on sell" : ""} onClick={() => setSide("sell")}>卖出</button>
        </div>
        <div className="row"><span>代码</span><b>{symbol}</b></div>
        <div className="row"><span>最新价</span><b>{last == null ? "…" : money(last)}</b></div>
        {pos && <div className="row"><span>持仓</span><b>{pos.qty} 股 · 成本 {money(pos.avg_cost)}</b></div>}
        <div className="seg full">
          <button className={type === "market" ? "on" : ""} onClick={() => setType("market")}>市价</button>
          <button className={type === "limit" ? "on" : ""} onClick={() => setType("limit")}>限价</button>
        </div>
        {type === "limit" && (
          <label className="field"><span>限价</span><input type="number" step="0.01" min="0" value={limit} onChange={e => setLimit(e.target.value)} /></label>
        )}
        <label className="field">
          <span>数量（股）</span>
          <input type="number" min="1" step="1" value={qty} onChange={e => setQty(e.target.value)} />
        </label>
        <div className="quick">
          {side === "buy"
            ? [0.25, 0.5, 1].map(f => <button key={f} onClick={() => setQty(String(Math.max(1, Math.floor(maxBuy * f))))}>{f === 1 ? "最多" : `${f * 100}%`}</button>)
            : [0.5, 1].map(f => <button key={f} disabled={!pos} onClick={() => pos && setQty(String(Math.max(1, Math.floor(pos.qty * f))))}>{f === 1 ? "全部" : "一半"}</button>)}
        </div>
        <div className="row"><span>预估金额</span><b>{price ? money(amount) : "…"}</b></div>
        {side === "buy" && <div className="row dim"><span>最多可买</span><span>{maxBuy} 股</span></div>}
        {(problem || err) && <div className="warn">{err || problem}</div>}
        <button className={"submit " + side} disabled={!!problem || busy || last == null}
          onClick={() => setConfirm({ symbol, side, type, qty: n, ...(type === "limit" ? { limit_price: Number(limit) } : {}) })}>
          {side === "buy" ? "买入" : "卖出"} {symbol}
        </button>
        <p className="hint">按最新价（有延迟）模拟成交，不考虑开盘时间和手续费。</p>
      </div>

      {confirm && (
        <div className="mask" onClick={() => !busy && setConfirm(null)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h3>确认{confirm.side === "buy" ? "买入" : "卖出"}</h3>
            <dl>
              <dt>代码</dt><dd>{confirm.symbol}</dd>
              <dt>方向</dt><dd className={confirm.side}>{confirm.side === "buy" ? "买入" : "卖出"}</dd>
              <dt>类型</dt><dd>{confirm.type === "market" ? "市价" : `限价 ${money(confirm.limit_price!)}`}</dd>
              <dt>数量</dt><dd>{confirm.qty} 股</dd>
              <dt>预估金额</dt><dd>{money(amount)}</dd>
            </dl>
            <div className="btns">
              <button onClick={() => setConfirm(null)} disabled={busy}>取消</button>
              <button className={"submit " + confirm.side} onClick={submit} disabled={busy}>{busy ? "提交中…" : "确认下单"}</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

const STATUS: Record<Order["status"], string> = { pending: "未成交", filled: "已成交", cancelled: "已撤单", rejected: "已拒绝" };
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—");

/** 图表下方：持仓 / 委托 */
export function Portfolio({ account, orders, color, onPick, onCancel, onReset }: {
  account: Account | null; orders: Order[]; color: ColorFn;
  onPick: (s: string) => void; onCancel: (id: number) => void; onReset: () => void;
}) {
  const [tab, setTab] = useState<"pos" | "open" | "all">("pos");
  const open = orders.filter(o => o.status === "pending");
  return (
    <section className="book">
      <div className="book-hd">
        <div className="tabs">
          <button className={tab === "pos" ? "on" : ""} onClick={() => setTab("pos")}>持仓 {account?.positions.length ?? 0}</button>
          <button className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>未成交 {open.length}</button>
          <button className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>全部委托 {orders.length}</button>
        </div>
        <button className="link" onClick={onReset}>重置模拟账户</button>
      </div>
      <div className="tbl">
        {tab === "pos" && (
          account?.positions.length ? (
            <table>
              <thead><tr><th>代码</th><th>数量</th><th>成本价</th><th>最新价</th><th>市值</th><th>浮动盈亏</th></tr></thead>
              <tbody>{account.positions.map(p => (
                <tr key={p.symbol} onClick={() => onPick(p.symbol)} className="click">
                  <td><b>{p.symbol}</b></td><td>{p.qty}</td><td>{money(p.avg_cost)}</td><td>{p.last == null ? "—" : money(p.last)}</td>
                  <td>{p.market_value == null ? "—" : money(p.market_value)}</td>
                  <td className={p.pnl == null ? "" : color(p.pnl)}>{p.pnl == null ? "—" : `${sign(p.pnl)}（${pct(p.pnl_pct!)}）`}</td>
                </tr>))}
              </tbody>
            </table>
          ) : <div className="none">还没有持仓。在右边下一单试试。</div>
        )}
        {tab !== "pos" && (
          (tab === "open" ? open : orders).length ? (
            <table>
              <thead><tr><th>时间</th><th>代码</th><th>方向</th><th>类型</th><th>数量</th><th>成交价</th><th>状态</th><th></th></tr></thead>
              <tbody>{(tab === "open" ? open : orders).map(o => (
                <tr key={o.id}>
                  <td className="dim">{time(o.created_at)}</td>
                  <td><b className="click" onClick={() => onPick(o.symbol)}>{o.symbol}</b></td>
                  <td className={o.side}>{o.side === "buy" ? "买入" : "卖出"}</td>
                  <td>{o.type === "market" ? "市价" : `限价 ${money(o.limit_price!)}`}</td>
                  <td>{o.qty}</td>
                  <td>{o.fill_price == null ? "—" : money(o.fill_price)}</td>
                  <td title={o.reason ?? ""}>{STATUS[o.status]}{o.reason ? `（${o.reason}）` : ""}</td>
                  <td>{o.status === "pending" && <button className="mini" onClick={() => onCancel(o.id)}>撤单</button>}</td>
                </tr>))}
              </tbody>
            </table>
          ) : <div className="none">{tab === "open" ? "没有未成交的委托。" : "还没有委托记录。"}</div>
        )}
      </div>
    </section>
  );
}
