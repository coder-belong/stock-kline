"""行情后端：K 线、报价、搜索。数据来自 yfinance（Yahoo Finance 非官方接口，免费、有延迟，只适合自己看）。

- GET /api/kline?symbol=QQQ&range=3y   K 线。1d / 5d 是分时（5 分钟 / 15 分钟一根），其余是日 K
- GET /api/quote?symbol=NVDA           报价：最新价、涨跌、今开 / 最高 / 最低 / 昨收、成交量、名称、市场状态
- GET /api/search?q=nvid               代码联想
同一个请求在缓存时间内只问一次 Yahoo，避免被限流；取失败时有旧数据就先用旧的。
"""
from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, TypeVar
from zoneinfo import ZoneInfo

import yfinance as yf
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

from auth import router as auth_router
from live import router as live_router
from paper import router as paper_router

log = logging.getLogger("kline")

# Vercel 上只有 /tmp 能写，yfinance 的时区 / cookie 缓存放那儿
if os.environ.get("VERCEL"):
    yf.set_tz_cache_location("/tmp/py-yfinance")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="stock-kline")
app.include_router(auth_router)
app.include_router(paper_router)
app.include_router(live_router)

ET = ZoneInfo("America/New_York")
EPOCH = datetime(1970, 1, 1)

#: 时间范围：分时用 (period, interval)，日 K 用往前推的天数（yfinance 的 period 没有 3y，统一按起始日期取）
INTRADAY = {"1d": ("1d", "5m"), "5d": ("5d", "15m")}
DAILY = {"1mo": 31, "3mo": 92, "6mo": 183, "1y": 366, "2y": 731, "3y": 1096, "5y": 1827}
TTL = {"intraday": 60, "daily": 300, "quote": 20, "name": 86400, "search": 3600}


# ---------- 小缓存 ----------
T = TypeVar("T")
_cache: dict[tuple, tuple[float, Any]] = {}
_lock = threading.Lock()


def cached(key: tuple, ttl: int, fetch: Callable[[], T]) -> T:
    with _lock:
        hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        val = fetch()
    except HTTPException:
        raise
    except Exception as e:  # 网络不通、被限流……有旧的先用旧的
        log.warning("取 %s 失败：%s", key, e)
        if hit:
            return hit[1]
        raise HTTPException(502, f"从 Yahoo 取数据失败：{e}") from e
    with _lock:
        _cache[key] = (time.time(), val)
    return val


# ---------- K 线 ----------
class Bar(BaseModel):
    #: 日 K 是交易日 "YYYY-MM-DD"；分时是秒数——把美东钟点当成 UTC 算的，图表直接显示美东时间
    time: str | int
    open: float
    high: float
    low: float
    close: float
    volume: int


class Kline(BaseModel):
    symbol: str
    range: str
    intraday: bool
    bars: list[Bar]
    fetched_at: float


def _bars(df, intraday: bool) -> list[Bar]:
    out = []
    for idx, r in df.iterrows():
        if intraday:
            t: str | int = int((idx.tz_convert(ET).replace(tzinfo=None) - EPOCH).total_seconds())
        else:
            t = idx.strftime("%Y-%m-%d")
        out.append(Bar(time=t, open=round(float(r["Open"]), 4), high=round(float(r["High"]), 4),
                       low=round(float(r["Low"]), 4), close=round(float(r["Close"]), 4), volume=int(r["Volume"] or 0)))
    return out


@app.get("/api/kline", response_model=Kline)
def kline(symbol: str = Query(min_length=1, max_length=20), range: str = Query("3y")) -> Kline:  # noqa: A002
    symbol = symbol.strip().upper()
    if range not in INTRADAY and range not in DAILY:
        raise HTTPException(400, f"range 只能是 {', '.join([*INTRADAY, *DAILY])}")
    intraday = range in INTRADAY

    def fetch() -> Kline:
        t = yf.Ticker(symbol)
        if intraday:
            period, interval = INTRADAY[range]
            df = t.history(period=period, interval=interval)
        else:
            start = (datetime.now(timezone.utc) - timedelta(days=DAILY[range])).strftime("%Y-%m-%d")
            df = t.history(start=start, interval="1d", auto_adjust=False)
        if df.empty:
            raise HTTPException(404, f"没查到 {symbol} 的数据：代码写错了，或者 Yahoo 暂时没返回")
        k = Kline(symbol=symbol, range=range, intraday=intraday, bars=_bars(df, intraday), fetched_at=time.time())
        log.info("取到 %s %s：%d 根", symbol, range, len(k.bars))
        return k

    return cached(("kline", symbol, range), TTL["intraday" if intraday else "daily"], fetch)


# ---------- 报价 ----------
class Quote(BaseModel):
    symbol: str
    name: str | None
    currency: str | None
    last: float
    prev_close: float | None
    change: float | None
    change_pct: float | None
    open: float
    high: float
    low: float
    volume: int
    day: str               # 这组数据是哪个交易日（美东；加密货币按 UTC 切日）
    asset: str             # stock / etf / index / crypto ……
    market: str            # pre / open / post / closed
    market_label: str
    et_now: str            # 美东现在几点，页面上显示


def market_state(now: datetime | None = None) -> tuple[str, str]:
    """按美东钟点粗算市场状态（不认节假日）。"""
    now = (now or datetime.now(ET)).astimezone(ET)
    if now.weekday() >= 5:
        return "closed", "休市（周末）"
    m = now.hour * 60 + now.minute
    if 4 * 60 <= m < 9 * 60 + 30:
        return "pre", "盘前"
    if 9 * 60 + 30 <= m < 16 * 60:
        return "open", "交易中"
    if 16 * 60 <= m < 20 * 60:
        return "post", "盘后"
    return "closed", "已收盘"


def _name(symbol: str) -> str | None:
    def fetch() -> str | None:
        info = yf.Ticker(symbol).info
        return info.get("shortName") or info.get("longName")
    try:
        return cached(("name", symbol), TTL["name"], fetch)
    except HTTPException:
        return None


@app.get("/api/quote", response_model=Quote)
def quote(symbol: str = Query(min_length=1, max_length=20)) -> Quote:
    symbol = symbol.strip().upper()

    def fetch() -> Quote:
        t = yf.Ticker(symbol)
        df = t.history(period="5d", interval="1d")
        if df.empty:
            raise HTTPException(404, f"没查到 {symbol}")
        cur, prev = df.iloc[-1], (df.iloc[-2] if len(df) > 1 else None)
        last = float(cur["Close"])
        pc = float(prev["Close"]) if prev is not None else None
        try:
            currency = t.fast_info["currency"]
        except Exception:
            currency = None
        try:
            itype = (t.history_metadata or {}).get("instrumentType", "")
        except Exception:
            itype = ""
        asset = {"CRYPTOCURRENCY": "crypto", "ETF": "etf", "INDEX": "index", "EQUITY": "stock"}.get(itype, itype.lower() or "stock")
        return Quote(symbol=symbol, name=None, currency=currency, last=round(last, 4),
                     prev_close=round(pc, 4) if pc else None,
                     change=round(last - pc, 4) if pc else None, change_pct=(last - pc) / pc if pc else None,
                     open=round(float(cur["Open"]), 4), high=round(float(cur["High"]), 4), low=round(float(cur["Low"]), 4),
                     volume=int(cur["Volume"] or 0), day=df.index[-1].strftime("%Y-%m-%d"), asset=asset,
                     market="", market_label="", et_now="")

    q = cached(("quote", symbol), TTL["quote"], fetch)
    state, label = ("open", "24 小时交易") if q.asset == "crypto" else market_state()
    return q.model_copy(update={"name": _name(symbol), "market": state, "market_label": label,
                                "et_now": datetime.now(ET).strftime("%m-%d %H:%M")})


# ---------- 搜索 ----------
class SearchItem(BaseModel):
    symbol: str
    name: str
    type: str
    exchange: str


@app.get("/api/search", response_model=list[SearchItem])
def search(q: str = Query(min_length=1, max_length=30)) -> list[SearchItem]:
    key = q.strip().lower()

    def fetch() -> list[SearchItem]:
        out = []
        for r in yf.Search(key, max_results=10).quotes:
            if r.get("quoteType") not in ("EQUITY", "ETF", "INDEX"):
                continue
            out.append(SearchItem(symbol=r.get("symbol", ""), name=r.get("shortname") or r.get("longname") or "",
                                  type={"EQUITY": "股票", "ETF": "ETF", "INDEX": "指数"}[r["quoteType"]],
                                  exchange=r.get("exchDisp") or ""))
        return out[:8]

    return cached(("search", key), TTL["search"], fetch)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
