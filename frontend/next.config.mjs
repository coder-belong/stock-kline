/** @type {import('next').NextConfig} */
// 前端只管页面，/api/* 全部转给 Python 后端：本机是 8090，部署时用 API_ORIGIN 指到后端域名
const API_ORIGIN = process.env.API_ORIGIN || "http://127.0.0.1:8090";

const nextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
  },
};
export default nextConfig;
