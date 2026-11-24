import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "美股行情 · 模拟交易", description: "自己看美股行情、做模拟交易" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
