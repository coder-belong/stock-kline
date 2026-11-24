"""模拟账户：每个登录用户一份虚拟资金，买卖美股；另外存每个用户的自选列表。数据在 Postgres（见 db.py）。

规则（够自己练手）：
- 成交价＝下单时的最新价（Yahoo，有延迟），不考虑开盘时间、滑点；手续费 0。
- 市价单：立刻按最新价成交。
- 限价单：买单最新价 ≤ 限价、卖单最新价 ≥ 限价就立刻按最新价成交；否则挂着，每次查账户 / 委托时再判断一次。
- 不能做空：卖出数量不能超过持仓（扣掉已挂着的卖单）；买入金额不能超过可用现金（挂着的限价买单会占用现金）。
- 风控：单笔金额上限 MAX_ORDER_VALUE。
"""
from __future__ import annotations

import time
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

import psycopg
import yfinance as yf
from fastapi import APIRouter, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

import db
from auth import DEFAULT_CASH, CurrentUser

router = APIRouter(tags=["paper"])

MAX_ORDER_VALUE = 50_000.0
SNAPSHOT_EVERY_S = 300       # 总资产快照：最多 5 分钟记一次（查账户时顺手记）
ET = ZoneInfo("America/New_York")
EPOCH = datetime(1970, 1, 1)
PRICE_TTL_S = 30
_price_cache: dict[str, tuple[float, float]] = {}


# ---------- 价格 ----------
def last_price(symbol: str) -> float:
    hit = _price_cache.get(symbol)
    if hit and time.time() - hit[1] < PRICE_TTL_S:
        return hit[0]
    try:
        p = float(yf.Ticker(symbol).fast_info["last_price"])
    except Exception:
        p = float("nan")
    if not p or p != p:  # 拿不到就退回最近一根日 K 的收盘
        df = yf.Ticker(symbol).history(period="5d", interval="1d")
        if df.empty:
            raise HTTPException(404, f"拿不到 {symbol} 的价格")
        p = float(df["Close"].iloc[-1])
    p = round(p, 4)
    _price_cache[symbol] = (p, time.time())
    return p


# ---------- 撮合 ----------
def _reserved_cash(c: psycopg.Connection, uid: int) -> float:
    rows = c.execute("select qty, limit_price from orders where user_id=%s and status='pending' and side='buy'", (uid,)).fetchall()
    return sum(r["qty"] * r["limit_price"] for r in rows)


def _pending_sell_qty(c: psycopg.Connection, uid: int, symbol: str) -> int:
    rows = c.execute("select qty from orders where user_id=%s and status='pending' and side='sell' and symbol=%s", (uid, symbol)).fetchall()
    return sum(r["qty"] for r in rows)


def _fill(c: psycopg.Connection, uid: int, order_id: int, symbol: str, side: str, qty: int, price: float) -> None:
    cash = c.execute("select cash from accounts where user_id=%s", (uid,)).fetchone()["cash"]
    pos = c.execute("select qty, avg_cost from positions where user_id=%s and symbol=%s", (uid, symbol)).fetchone()
    if side == "buy":
        cost = qty * price
        if cost > cash + 1e-6:
            c.execute("update orders set status='rejected', reason=%s where id=%s", ("现金不足", order_id))
            return
        if pos:
            nq = pos["qty"] + qty
            c.execute("update positions set qty=%s, avg_cost=%s where user_id=%s and symbol=%s",
                      (nq, (pos["qty"] * pos["avg_cost"] + cost) / nq, uid, symbol))
        else:
            c.execute("insert into positions values (%s, %s, %s, %s)", (uid, symbol, qty, price))
        c.execute("update accounts set cash = cash - %s where user_id=%s", (cost, uid))
    else:
        if not pos or pos["qty"] < qty:
            c.execute("update orders set status='rejected', reason=%s where id=%s", ("持仓不足", order_id))
            return
        nq = pos["qty"] - qty
        if nq == 0:
            c.execute("delete from positions where user_id=%s and symbol=%s", (uid, symbol))
        else:
            c.execute("update positions set qty=%s where user_id=%s and symbol=%s", (nq, uid, symbol))
        c.execute("update accounts set cash = cash + %s where user_id=%s", (qty * price, uid))
    c.execute("update orders set status='filled', fill_price=%s, filled_at=%s where id=%s", (price, db.now(), order_id))


def _marketable(side: str, last: float, limit: float) -> bool:
    return last <= limit if side == "buy" else last >= limit


def _match_pending(c: psycopg.Connection, uid: int) -> None:
    for o in c.execute("select * from orders where user_id=%s and status='pending' order by id", (uid,)).fetchall():
        try:
            p = last_price(o["symbol"])
        except HTTPException:
            continue
        if _marketable(o["side"], p, o["limit_price"]):
            _fill(c, uid, o["id"], o["symbol"], o["side"], o["qty"], p)


def _ensure_account(c: psycopg.Connection, uid: int) -> dict:
    acc = c.execute("select * from accounts where user_id=%s", (uid,)).fetchone()
    if acc is None:
        c.execute("insert into accounts values (%s, %s, %s, %s)", (uid, DEFAULT_CASH, DEFAULT_CASH, db.now()))
        acc = c.execute("select * from accounts where user_id=%s", (uid,)).fetchone()
    return acc


# ---------- 模型 ----------
class OrderIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=20)
    side: Literal["buy", "sell"]
    type: Literal["market", "limit"] = "market"
    qty: int = Field(gt=0, le=1_000_000)
    limit_price: float | None = Field(default=None, gt=0)


class Order(BaseModel):
    id: int
    symbol: str
    side: str
    type: str
    qty: int
    limit_price: float | None
    status: str
    fill_price: float | None
    reason: str | None
    created_at: str
    filled_at: str | None


def _order(r: dict) -> Order:
    d = dict(r)
    d.pop("user_id", None)
    return Order(**d)


class Position(BaseModel):
    symbol: str
    qty: int
    avg_cost: float
    last: float | None
    market_value: float | None
    pnl: float | None
    pnl_pct: float | None


class Account(BaseModel):
    day_pnl: float           # 今日盈亏：现在的总资产 − 今天（美东）第一次记录的总资产
    day_pnl_pct: float
    cash: float
    reserved: float
    available: float
    initial_cash: float
    market_value: float
    equity: float
    pnl: float
    pnl_pct: float
    positions: list[Position]
    max_order_value: float
    created_at: str


# ---------- 接口 ----------
@router.get("/api/paper/account", response_model=Account)
def account(user: CurrentUser) -> Account:
    uid = user.id
    with db.conn() as c:
        db.lock_user(c, user.id)
        acc = _ensure_account(c, uid)
        _match_pending(c, uid)
        acc = c.execute("select * from accounts where user_id=%s", (uid,)).fetchone()
        reserved = _reserved_cash(c, uid)
        positions, mv = [], 0.0
        for r in c.execute("select * from positions where user_id=%s order by symbol", (uid,)).fetchall():
            try:
                p = last_price(r["symbol"])
                v = r["qty"] * p
                pnl = v - r["qty"] * r["avg_cost"]
                positions.append(Position(symbol=r["symbol"], qty=r["qty"], avg_cost=round(r["avg_cost"], 4), last=p,
                                          market_value=round(v, 2), pnl=round(pnl, 2), pnl_pct=pnl / (r["qty"] * r["avg_cost"])))
                mv += v
            except HTTPException:
                positions.append(Position(symbol=r["symbol"], qty=r["qty"], avg_cost=r["avg_cost"], last=None,
                                          market_value=None, pnl=None, pnl_pct=None))
                mv += r["qty"] * r["avg_cost"]
        equity = acc["cash"] + mv
        day_start = _snapshot(c, uid, equity, acc["cash"], mv)
        day_pnl = equity - day_start
        return Account(day_pnl=round(day_pnl, 2), day_pnl_pct=day_pnl / day_start if day_start else 0.0,
                       cash=round(acc["cash"], 2), reserved=round(reserved, 2), available=round(acc["cash"] - reserved, 2),
                       initial_cash=acc["initial_cash"], market_value=round(mv, 2), equity=round(equity, 2),
                       pnl=round(equity - acc["initial_cash"], 2), pnl_pct=(equity - acc["initial_cash"]) / acc["initial_cash"],
                       positions=positions, max_order_value=MAX_ORDER_VALUE, created_at=acc["created_at"])


def _snapshot(c: psycopg.Connection, uid: int, equity: float, cash: float, mv: float) -> float:
    """记一笔总资产快照（离上次超过 SNAPSHOT_EVERY_S 才记），返回今天开始时的总资产。"""
    now = int(time.time())
    today = datetime.now(ET).strftime("%Y-%m-%d")
    last = c.execute("select ts from equity_snapshots where user_id=%s order by ts desc limit 1", (uid,)).fetchone()
    if last is None or now - last["ts"] >= SNAPSHOT_EVERY_S:
        c.execute("insert into equity_snapshots values (%s, %s, %s, %s, %s, %s) on conflict do nothing", (uid, now, today, equity, cash, mv))
    first = c.execute("select equity from equity_snapshots where user_id=%s and et_day=%s order by ts limit 1", (uid, today)).fetchone()
    return first["equity"] if first else equity


class EquityPoint(BaseModel):
    time: int        # 美东钟点当成 UTC 的秒数，前端图表直接显示美东时间
    equity: float


@router.get("/api/paper/equity", response_model=list[EquityPoint])
def equity_history(user: CurrentUser) -> list[EquityPoint]:
    """总资产走势：所有快照（开户时先补一个起点）。"""
    with db.conn() as c:
        acc = _ensure_account(c, user.id)
        rows = c.execute("select ts, equity from equity_snapshots where user_id=%s order by ts", (user.id,)).fetchall()
    def et_secs(ts: int) -> int:
        return int((datetime.fromtimestamp(ts, ET).replace(tzinfo=None) - EPOCH).total_seconds())
    pts = [EquityPoint(time=et_secs(r["ts"]), equity=round(r["equity"], 2)) for r in rows]
    start = int(datetime.fromisoformat(acc["created_at"]).timestamp())
    if not pts or pts[0].time > et_secs(start):
        pts.insert(0, EquityPoint(time=et_secs(start), equity=acc["initial_cash"]))
    # 同一秒只留一个（图表要求时间严格递增）
    out: list[EquityPoint] = []
    for p in pts:
        if out and p.time <= out[-1].time:
            out[-1] = p
        else:
            out.append(p)
    return out


@router.get("/api/paper/orders", response_model=list[Order])
def orders(user: CurrentUser) -> list[Order]:
    with db.conn() as c:
        db.lock_user(c, user.id)
        _match_pending(c, user.id)
        return [_order(r) for r in c.execute("select * from orders where user_id=%s order by id desc limit 200", (user.id,)).fetchall()]


@router.get("/api/paper/quote")
def quote(symbol: str) -> dict[str, float | str]:
    s = symbol.strip().upper()
    return {"symbol": s, "last": last_price(s)}


@router.post("/api/paper/orders", response_model=Order, status_code=201)
def place(o: OrderIn, user: CurrentUser) -> Order:
    uid, symbol = user.id, o.symbol.strip().upper()
    if o.type == "limit" and o.limit_price is None:
        raise HTTPException(400, "限价单要填限价")
    last = last_price(symbol)
    value = o.qty * (o.limit_price if o.type == "limit" else last)
    if value > MAX_ORDER_VALUE:
        raise HTTPException(400, f"单笔金额 {value:,.0f} 超过上限 {MAX_ORDER_VALUE:,.0f}（风控）")
    with db.conn() as c:
        db.lock_user(c, user.id)
        cash = _ensure_account(c, uid)["cash"]
        free_cash = cash - _reserved_cash(c, uid)
        if o.side == "buy" and value > free_cash + 1e-6:
            raise HTTPException(400, f"可用现金不足：需要 {value:,.2f}，可用 {free_cash:,.2f}")
        if o.side == "sell":
            pos = c.execute("select qty from positions where user_id=%s and symbol=%s", (uid, symbol)).fetchone()
            free = (pos["qty"] if pos else 0) - _pending_sell_qty(c, uid, symbol)
            if o.qty > free:
                raise HTTPException(400, f"可卖数量不足：持仓可卖 {max(free, 0)} 股（不支持做空）")
        oid = c.execute(
            "insert into orders (user_id, symbol, side, type, qty, limit_price, status, created_at) values (%s, %s, %s, %s, %s, %s, 'pending', %s) returning id",
            (uid, symbol, o.side, o.type, o.qty, o.limit_price, db.now())).fetchone()["id"]
        if o.type == "market" or _marketable(o.side, last, o.limit_price or 0):
            _fill(c, uid, oid, symbol, o.side, o.qty, last)
        c.commit()
        return _order(c.execute("select * from orders where id=%s", (oid,)).fetchone())


@router.post("/api/paper/orders/{order_id}/cancel", response_model=Order)
def cancel(order_id: int, user: CurrentUser) -> Order:
    with db.conn() as c:
        db.lock_user(c, user.id)
        r = c.execute("select * from orders where id=%s and user_id=%s", (order_id, user.id)).fetchone()
        if r is None:
            raise HTTPException(404, "没有这笔委托")
        if r["status"] != "pending":
            raise HTTPException(409, "只有未成交的委托能撤")
        c.execute("update orders set status='cancelled' where id=%s", (order_id,))
        c.commit()
        return _order(c.execute("select * from orders where id=%s", (order_id,)).fetchone())


class ResetIn(BaseModel):
    initial_cash: float = Field(default=DEFAULT_CASH, gt=0, le=100_000_000)


@router.post("/api/paper/reset", response_model=Account)
def reset(body: ResetIn, user: CurrentUser) -> Account:
    with db.conn() as c:
        db.lock_user(c, user.id)
        c.execute("delete from positions where user_id=%s", (user.id,))
        c.execute("delete from orders where user_id=%s", (user.id,))
        c.execute("delete from equity_snapshots where user_id=%s", (user.id,))
        c.execute("insert into accounts values (%s, %s, %s, %s) on conflict (user_id) do update"
                  " set cash=excluded.cash, initial_cash=excluded.initial_cash, created_at=excluded.created_at",
                  (user.id, body.initial_cash, body.initial_cash, db.now()))
        c.commit()
    return account(user)


# ---------- 自选（跟着账号走） ----------
class WatchItem(BaseModel):
    symbol: str = Field(min_length=1, max_length=20)
    name: str = Field(default="", max_length=60)


@router.get("/api/watchlist", response_model=list[WatchItem] | None)
def get_watchlist(user: CurrentUser) -> list[WatchItem] | None:
    """还没存过返回 null，前端就把本机的自选传上来。"""
    with db.conn() as c:
        r = c.execute("select items from watchlists where user_id=%s", (user.id,)).fetchone()
    return [WatchItem(**x) for x in r["items"]] if r else None


@router.put("/api/watchlist", response_model=list[WatchItem])
def put_watchlist(items: list[WatchItem], user: CurrentUser) -> list[WatchItem]:
    items = items[:100]
    with db.conn() as c:
        c.execute("insert into watchlists values (%s, %s, %s) on conflict (user_id) do update"
                  " set items=excluded.items, updated_at=excluded.updated_at",
                  (user.id, Jsonb([i.model_dump() for i in items]), db.now()))
        c.commit()
    return items
