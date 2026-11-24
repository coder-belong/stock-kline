"use client";

import { useEffect, useRef, useState } from "react";
import {
  ColorType, CrosshairMode, LineStyle, createChart,
  type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type Time,
} from "lightweight-charts";
import { fmtTime, fmtVol, movingAverage, num, pct, type Bar } from "@/lib/api";

export type ChartMode = "candle" | "line";
type Props = {
  bars: Bar[]; intraday: boolean; mode: ChartMode; showMA: boolean; showVol: boolean;
  upRed: boolean; dark: boolean; baseline: number | null;  // 分时图的昨收线
  fitKey: string;  // 换代码 / 换范围时才重新铺满；实时推送更新最后一根时不动用户的缩放
};

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const MA = [{ n: 5, color: "#e0a526" }, { n: 20, color: "#3b82f6" }, { n: 60, color: "#a855f7" }];

export default function Chart({ bars, intraday, mode, showMA, showVol, upRed, dark, baseline, fitKey }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const s = useRef<{
    candle: ISeriesApi<"Candlestick">; area: ISeriesApi<"Area">; vol: ISeriesApi<"Histogram">;
    ma: ISeriesApi<"Line">[]; base: IPriceLine | null;
  } | null>(null);
  const [hover, setHover] = useState<Bar | null>(null);

  // 建图：只建一次
  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderVisible: false, rightOffset: 3 },
      rightPriceScale: { borderVisible: false },
      localization: { locale: "zh-CN", timeFormatter: (t: Time) => fmtTime(t as Bar["time"]) },
    });
    const candle = c.addCandlestickSeries({ priceLineVisible: true });
    const area = c.addAreaSeries({ lineWidth: 2, priceLineVisible: true, visible: false });
    const vol = c.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    c.priceScale("right").applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
    const ma = MA.map(m => c.addLineSeries({ color: m.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }));
    s.current = { candle, area, vol, ma, base: null };
    chart.current = c;
    const onMove = (p: MouseEventParams<Time>) => {
      if (!p.time) return setHover(null);
      const d = p.seriesData.get(candle) as { open: number; high: number; low: number; close: number } | undefined;
      const v = p.seriesData.get(vol) as { value: number } | undefined;
      if (!d) return setHover(null);
      setHover({ time: p.time as Bar["time"], ...d, volume: v?.value ?? 0 });
    };
    c.subscribeCrosshairMove(onMove);
    // 容器宽度变了（拖窗口、换布局）就重新铺满
    let w = 0;
    const ro = new ResizeObserver(([e]) => {
      const nw = Math.round(e.contentRect.width);
      if (nw && nw !== w) { w = nw; c.timeScale().fitContent(); }
    });
    ro.observe(box.current!);
    return () => { ro.disconnect(); c.unsubscribeCrosshairMove(onMove); c.remove(); chart.current = null; s.current = null; };
  }, []);

  // 数据和样式
  useEffect(() => {
    const c = chart.current, x = s.current;
    if (!c || !x) return;
    const up = upRed ? css("--up") : css("--down"), down = upRed ? css("--down") : css("--up");
    c.applyOptions({
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--sub"), fontSize: 12 },
      grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
      timeScale: { timeVisible: intraday, secondsVisible: false },
    });
    const T = (t: Bar["time"]) => t as Time;
    x.candle.applyOptions({ visible: mode === "candle", upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
    x.candle.setData(bars.map(b => ({ time: T(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));
    const last = bars[bars.length - 1], ref = baseline ?? bars[0]?.open ?? 0;
    const lineColor = last && last.close >= ref ? up : down;
    x.area.applyOptions({ visible: mode === "line", lineColor, topColor: lineColor + "40", bottomColor: lineColor + "05" });
    x.area.setData(bars.map(b => ({ time: T(b.time), value: b.close })));
    x.vol.applyOptions({ visible: showVol });
    x.vol.setData(bars.map(b => ({ time: T(b.time), value: b.volume, color: (b.close >= b.open ? up : down) + "70" })));
    MA.forEach((m, i) => {
      x.ma[i].applyOptions({ visible: showMA && mode === "candle" });
      x.ma[i].setData(movingAverage(bars, m.n).map(p => ({ time: T(p.time), value: p.value })));
    });
    // 昨收线：分时图上画一条虚线
    const main = mode === "candle" ? x.candle : x.area;
    if (x.base) { try { x.candle.removePriceLine(x.base); x.area.removePriceLine(x.base); } catch { /* 不在这条线上 */ } x.base = null; }
    if (intraday && baseline) {
      x.base = main.createPriceLine({ price: baseline, color: css("--faint"), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "昨收" });
    }
    c.priceScale("right").applyOptions({ scaleMargins: { top: 0.08, bottom: showVol ? 0.22 : 0.05 } });
  }, [bars, intraday, mode, showMA, showVol, upRed, dark, baseline]);

  // 换代码、换范围：等宽度量好再铺满
  useEffect(() => {
    const id = requestAnimationFrame(() => chart.current?.timeScale().fitContent());
    return () => cancelAnimationFrame(id);
  }, [fitKey]);

  const shown = hover ?? bars[bars.length - 1];
  const i = shown ? bars.findIndex(b => b.time === shown.time) : -1;
  const prev = i > 0 ? bars[i - 1].close : null;
  const chg = shown && prev ? (shown.close - prev) / prev : null;
  const tone = (x: number | null) => (x == null || x === 0 ? "" : (x > 0) === upRed ? "up" : "down");

  return (
    <div className="chart-box">
      {shown && (
        <div className="legend">
          <span className="day">{fmtTime(shown.time)}</span>
          {mode === "candle" ? (
            <>
              <span>开 <b>{num(shown.open)}</b></span>
              <span>高 <b>{num(shown.high)}</b></span>
              <span>低 <b>{num(shown.low)}</b></span>
              <span>收 <b className={tone(chg)}>{num(shown.close)}</b></span>
            </>
          ) : <span>价 <b className={tone(chg)}>{num(shown.close)}</b></span>}
          {chg != null && <span className={tone(chg)}>{pct(chg)}</span>}
          {showVol && <span>量 <b>{fmtVol(shown.volume)}</b></span>}
          {showMA && mode === "candle" && (
            <span className="ma">{MA.map(m => <span key={m.n}><i style={{ background: m.color }} />MA{m.n}</span>)}</span>
          )}
        </div>
      )}
      <div ref={box} className="chart" />
    </div>
  );
}
