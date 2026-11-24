"""实时行情：后端连 Yahoo 的实时价格流（yfinance AsyncWebSocket），再用 WebSocket 推给浏览器。

    Yahoo streamer ──WebSocket──▶ Hub（一条上游连接，订阅所有浏览器要的代码的并集）
                                    └──WebSocket /api/ws──▶ 每个浏览器标签页

浏览器 → 后端：{"type": "subscribe", "symbols": ["NVDA", "QQQ"]}   （每次发完整列表，覆盖上一次）
后端 → 浏览器：{"type": "tick", ...}    价格变动
              {"type": "status", "upstream": "connected" | "connecting" | "error", "detail": "..."}

上游断了自动重连（3 秒起、最多 60 秒的退避）；90 秒收不到任何消息也当成断了（代理切换后旧连接会假死）；
没有浏览器连着时上游也断开，不白占连接。
不用 yfinance 自带的 listen：它断线后旧连接对象不清空，_connect 什么都不做，会一直卡着。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import yfinance as yf
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger("live")
router = APIRouter()
ET = ZoneInfo("America/New_York")
EPOCH = datetime(1970, 1, 1)
#: Yahoo 的 market_hours：0 盘前、1 盘中、2 盘后，其余（如 4）是夜盘 / 延长时段
SESSIONS = {0: ("pre", "盘前"), 1: ("regular", "盘中"), 2: ("post", "盘后")}


def to_tick(m: dict) -> dict | None:
    """Yahoo 原始消息 → 推给前端的格式。时间同时给 ET 日期和「美东钟点当 UTC」的秒数，前端直接拿来更新 K 线。"""
    sym, price = m.get("id"), m.get("price")
    if not sym or price is None:
        return None
    try:
        ts = datetime.fromtimestamp(int(m.get("time", 0)) / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        ts = datetime.now(timezone.utc)
    et = ts.astimezone(ET)
    session, label = SESSIONS.get(m.get("market_hours", 1), ("overnight", "夜盘"))
    cp = m.get("change_percent")
    return {
        "type": "tick", "symbol": sym, "price": float(price),
        "change": m.get("change"), "change_pct": cp / 100 if cp is not None else None,
        "session": session, "session_label": label,
        "day_volume": int(m["day_volume"]) if m.get("day_volume") else None,
        "day_high": m.get("day_high"), "day_low": m.get("day_low"),
        "et_day": et.strftime("%Y-%m-%d"), "et_secs": int((et.replace(tzinfo=None) - EPOCH).total_seconds()),
        "et_time": et.strftime("%H:%M:%S"),
    }


class Hub:
    def __init__(self) -> None:
        self.clients: dict[WebSocket, set[str]] = {}
        self.last: dict[str, dict] = {}       # 每个代码最近一笔，新订阅时先补一笔
        self.status: dict = {"type": "status", "upstream": "idle"}
        self._up: yf.AsyncWebSocket | None = None
        self._subscribed: set[str] = set()
        self._task: asyncio.Task | None = None
        self._changed = asyncio.Event()
        self._last_msg = 0.0

    def wanted(self) -> set[str]:
        return set().union(*self.clients.values()) if self.clients else set()

    # ---- 浏览器侧 ----
    async def join(self, ws: WebSocket) -> None:
        self.clients[ws] = set()
        await ws.send_json(self.status)
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def leave(self, ws: WebSocket) -> None:
        self.clients.pop(ws, None)
        self._changed.set()

    async def set_symbols(self, ws: WebSocket, symbols: list[str]) -> None:
        syms = {s.strip().upper() for s in symbols if isinstance(s, str) and s.strip()}
        self.clients[ws] = set(list(syms)[:60])
        for s in self.clients[ws]:
            if s in self.last:
                await ws.send_json(self.last[s])
        self._changed.set()

    async def _broadcast(self, msg: dict) -> None:
        dead = []
        for ws, syms in list(self.clients.items()):
            if msg.get("type") == "status" or msg.get("symbol") in syms:
                try:
                    await ws.send_json(msg)
                except Exception:
                    dead.append(ws)
        for ws in dead:
            self.clients.pop(ws, None)

    async def _set_status(self, upstream: str, detail: str = "") -> None:
        self.status = {"type": "status", "upstream": upstream, "detail": detail}
        await self._broadcast(self.status)

    # ---- 上游（Yahoo）----
    async def _listen(self) -> None:
        """自己读上游消息：连接一断就抛出去，由 _run 重连。"""
        assert self._up is not None
        async for raw in self._up._ws:  # noqa: SLF001
            self._last_msg = time.time()
            data = json.loads(raw).get("message", "")
            await self._on_message(self._up._decode_message(data))  # noqa: SLF001

    async def _on_message(self, m: dict) -> None:
        t = to_tick(m)
        if t:
            self.last[t["symbol"]] = t
            await self._broadcast(t)

    async def _sync_subscriptions(self) -> None:
        """浏览器的订阅变了，就让上游跟着增减。"""
        while True:
            await self._changed.wait()
            self._changed.clear()
            if self._up is None:
                continue
            want = self.wanted()
            add, drop = want - self._subscribed, self._subscribed - want
            if add:
                await self._up.subscribe(sorted(add))
            if drop:
                await self._up.unsubscribe(sorted(drop))
            self._subscribed = want
            log.info("上游订阅：%s", sorted(want))

    async def _run(self) -> None:
        delay = 3
        while self.clients:
            await self._set_status("connecting")
            sync = None
            try:
                self._up = yf.AsyncWebSocket(verbose=False)
                self._subscribed = set()
                await self._up._connect()  # noqa: SLF001 先连上，订阅交给 _sync_subscriptions
                await self._set_status("connected")
                delay = 3
                sync = asyncio.create_task(self._sync_subscriptions())
                self._changed.set()
                self._last_msg = time.time()
                listen = asyncio.create_task(self._listen())
                # 没有浏览器了就收工；上游断了或者 90 秒没消息就重连
                while self.clients and not listen.done() and time.time() - self._last_msg < 90:
                    await asyncio.sleep(1)
                listen.cancel()
                with contextlib.suppress(BaseException):
                    await listen
                if self.clients:
                    raise ConnectionError("上游连接断开或长时间没有消息")
            except Exception as e:  # 网络、代理、Yahoo 抽风
                log.warning("上游断开：%s，%s 秒后重连", e, delay)
                await self._set_status("error", str(e)[:200])
                await asyncio.sleep(delay)
                delay = min(delay * 2, 60)
            finally:
                if sync:
                    sync.cancel()
                if self._up:
                    with contextlib.suppress(Exception):
                        await self._up.close()
                self._up = None
        self.status = {"type": "status", "upstream": "idle"}
        log.info("没有浏览器连着，上游已断开")


hub = Hub()


@router.websocket("/api/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    # 部署后只让自己的前端连（SK_WS_ORIGINS=https://kline.belong.run），防止别人白嫖推送
    allowed = [o for o in os.environ.get("SK_WS_ORIGINS", "").split(",") if o]
    if allowed and ws.headers.get("origin") not in allowed:
        await ws.close(code=1008)
        return
    await ws.accept()
    await hub.join(ws)
    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "subscribe":
                await hub.set_symbols(ws, msg.get("symbols") or [])
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.info("浏览器连接异常：%s", e)
    finally:
        await hub.leave(ws)
