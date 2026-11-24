"use client";

import dynamic from "next/dynamic";

// 图表库和 localStorage 只能在浏览器里跑，整页关掉服务端渲染
const App = dynamic(() => import("@/components/App"), { ssr: false, loading: () => <div className="boot">加载中…</div> });

export default function Page() {
  return <App />;
}
