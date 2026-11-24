/** @type {import('next').NextConfig} */
// 前端只管页面，/api/* 全部转给 Python 后端：本机是 8090，部署时用 API_ORIGIN 指到后端域名
const API_ORIGIN = process.env.API_ORIGIN || "http://127.0.0.1:8090";

const nextConfig = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` },
      // 宣传页：静态文件在 public/intro/，访问 /intro 就显示
      { source: "/intro", destination: "/intro/index.html" },
    ];
  },
};
export default nextConfig;
