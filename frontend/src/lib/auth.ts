/** 账号和自选同步（后端 backend/auth.py、paper.py）。登录态在 HttpOnly Cookie 里，JS 读不到，只能问 /me。 */
export type User = { id: number; username: string };
export type WatchItem = { symbol: string; name: string };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, credentials: "same-origin", ...init });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const b = await res.json();
      if (b?.detail) msg = typeof b.detail === "string" ? b.detail : b.detail.map((d: { msg: string }) => d.msg).join("；");
    } catch { /* 用默认文案 */ }
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const auth = {
  me: () => call<User>("/api/auth/me"),
  login: (username: string, password: string) => call<User>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  register: (username: string, password: string) => call<User>("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => call<void>("/api/auth/logout", { method: "POST" }),
  getWatchlist: () => call<WatchItem[] | null>("/api/watchlist"),
  putWatchlist: (items: WatchItem[]) => call<WatchItem[]>("/api/watchlist", { method: "PUT", body: JSON.stringify(items) }),
};
