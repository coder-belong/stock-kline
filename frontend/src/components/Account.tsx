"use client";

import { useEffect, useRef, useState } from "react";
import { auth, type User } from "@/lib/auth";

/** 点外面关掉 */
function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", f);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", f); document.removeEventListener("keydown", k); };
  }, [open, close]);
  return ref;
}

/** 太阳 / 月亮：点一下切浅色 / 深色，新主题从按钮处画圆铺开（View Transitions，不支持的浏览器直接切） */
export function ThemeToggle({ dark, onToggle }: { dark: boolean; onToggle: (x: number, y: number) => void }) {
  return (
    <button className={"ibtn theme-tg" + (dark ? " dark" : "")} title={dark ? "切到浅色" : "切到深色"}
      onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onToggle(r.left + r.width / 2, r.top + r.height / 2); }}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <mask id="moon-cut">
          <rect x="0" y="0" width="24" height="24" fill="white" />
          <circle className="cut" cx="24" cy="4" r="8" fill="black" />
        </mask>
        <circle className="core" cx="12" cy="12" r="5" mask="url(#moon-cut)" fill="currentColor" stroke="none" />
        <g className="rays">
          <line x1="12" y1="1.5" x2="12" y2="3.5" /><line x1="12" y1="20.5" x2="12" y2="22.5" />
          <line x1="4.6" y1="4.6" x2="6" y2="6" /><line x1="18" y1="18" x2="19.4" y2="19.4" />
          <line x1="1.5" y1="12" x2="3.5" y2="12" /><line x1="20.5" y1="12" x2="22.5" y2="12" />
          <line x1="4.6" y1="19.4" x2="6" y2="18" /><line x1="18" y1="6" x2="19.4" y2="4.6" />
        </g>
      </svg>
    </button>
  );
}

/** 涨跌颜色：上箭头是「涨」的颜色、下箭头是「跌」的颜色，点一下红绿互换 */
export function UpDownToggle({ upRed, onToggle }: { upRed: boolean; onToggle: () => void }) {
  return (
    <button className={"ibtn updown" + (upRed ? "" : " flip")} onClick={onToggle}
      title={upRed ? "现在：红涨绿跌（点一下换成绿涨红跌）" : "现在：绿涨红跌（点一下换成红涨绿跌）"}>
      <svg viewBox="0 0 24 24" width="18" height="18">
        <path className="a-up" d="M7 3 L11.5 9.5 H2.5 Z" />
        <path className="a-dn" d="M17 21 L12.5 14.5 H21.5 Z" />
        <line x1="7" y1="9" x2="7" y2="21" className="s-up" />
        <line x1="17" y1="3" x2="17" y2="15" className="s-dn" />
      </svg>
    </button>
  );
}

/** 头像：没登录是「登录」按钮，登录了是首字母 + 下拉菜单 */
export function UserMenu({ user, onLogin, onLogout }: { user: User | null; onLogin: () => void; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  if (!user) return <button className="login-btn" onClick={onLogin}>登录</button>;
  return (
    <div className="pop-wrap" ref={ref}>
      <button className={"avatar" + (open ? " on" : "")} title={user.username} onClick={() => setOpen(o => !o)}>{user.username.slice(0, 1).toUpperCase()}</button>
      {open && (
        <div className="pop">
          <div className="pop-user"><span className="avatar lg">{user.username.slice(0, 1).toUpperCase()}</span><div><b>{user.username}</b><span>模拟账户和自选跟着账号走</span></div></div>
          <button className="pop-item danger" onClick={() => { setOpen(false); onLogout(); }}>退出登录</button>
        </div>
      )}
    </div>
  );
}

/** 登录 / 注册弹窗：左边品牌区（渐变 + 走势插画 + 卖点），右边表单 */
export function LoginDialog({ onClose, onDone }: { onClose: () => void; onDone: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);

  const close = () => { setClosing(true); setTimeout(onClose, 180); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fail = (msg: string) => { setErr(msg); setShake(n => n + 1); };
  const switchMode = (m: "login" | "register") => { setMode(m); setErr(""); setPassword2(""); };
  const strength = password.length === 0 ? 0 : Math.min(4,
    (password.length >= 6 ? 1 : 0) + (password.length >= 10 ? 1 : 0) + (/[A-Z]/.test(password) && /[a-z]/.test(password) ? 1 : 0) + (/\d/.test(password) && /[^A-Za-z0-9]/.test(password) ? 1 : 0));
  const ready = username.trim().length >= 2 && password.length >= 6 && (mode === "login" || password2.length > 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    if (mode === "register" && password !== password2) return fail("两次输入的密码不一样");
    setBusy(true); setErr("");
    try {
      const u = mode === "login" ? await auth.login(username.trim(), password) : await auth.register(username.trim(), password);
      onDone(u);
    } catch (e) {
      fail((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className={"mask auth-mask" + (closing ? " out" : "")} onMouseDown={close}>
      <div className="auth-card" onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="auth-x" onClick={close} aria-label="关闭">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>

        {/* 左：品牌区 */}
        <div className="auth-hero">
          <div className="auth-brand"><span className="logo">K</span><b>美股行情 · 模拟交易</b></div>
          <svg className="hero-chart" viewBox="0 0 260 120" preserveAspectRatio="none">
            <defs>
              <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".45" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
            </defs>
            <path d="M0 95 L20 88 L38 92 L58 70 L76 76 L96 58 L114 64 L134 40 L152 50 L172 34 L192 42 L212 22 L232 30 L260 12 L260 120 L0 120 Z" fill="url(#hg)" />
            <path className="hero-line" d="M0 95 L20 88 L38 92 L58 70 L76 76 L96 58 L114 64 L134 40 L152 50 L172 34 L192 42 L212 22 L232 30 L260 12" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
            <circle className="hero-dot" cx="260" cy="12" r="4" fill="#fff" />
          </svg>
          <h2>{mode === "login" ? "欢迎回来" : "开一个模拟账户"}</h2>
          <ul>
            <li><i>$</i>10 万美元虚拟资金，随便练手</li>
            <li><i>⚡</i>实时行情推送，盘前盘后夜盘都能看</li>
            <li><i>☁</i>持仓、委托、自选都存在账号里</li>
          </ul>
        </div>

        {/* 右：表单 */}
        <form className="auth-form" onSubmit={submit} noValidate>
          <div className={"auth-tabs " + mode}>
            <span className="auth-tab-bg" />
            <button type="button" className={mode === "login" ? "on" : ""} onClick={() => switchMode("login")}>登录</button>
            <button type="button" className={mode === "register" ? "on" : ""} onClick={() => switchMode("register")}>注册</button>
          </div>
          <p className="auth-sub">{mode === "login" ? "用你的账号继续模拟交易" : "只要用户名和密码，10 秒注册好"}</p>

          <label className="ifield">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>
            <input autoFocus value={username} onChange={e => setUsername(e.target.value)} placeholder=" " autoComplete="username" />
            <span>用户名</span>
          </label>
          <label className="ifield">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="4" y="10" width="16" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
            <input type={show ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} placeholder=" "
              autoComplete={mode === "login" ? "current-password" : "new-password"} />
            <span>密码</span>
            <button type="button" className="eye" onClick={() => setShow(v => !v)} aria-label={show ? "隐藏密码" : "显示密码"} tabIndex={-1}>
              {show
                ? <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
                : <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 3l18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>}
            </button>
          </label>
          {mode === "register" && (
            <>
              <div className={"strength s" + strength}><i /><i /><i /><i /><span>{["", "弱", "一般", "较强", "很强"][strength]}</span></div>
              <label className="ifield">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg>
                <input type={show ? "text" : "password"} value={password2} onChange={e => setPassword2(e.target.value)} placeholder=" " autoComplete="new-password" />
                <span>确认密码</span>
                {password2 && <em className={password2 === password ? "ok" : "no"}>{password2 === password ? "✓" : "✕"}</em>}
              </label>
            </>
          )}

          {err && <div className="auth-err" key={shake}>{err}</div>}

          <button className="auth-submit" disabled={!ready || busy}>
            {busy ? <span className="spin" /> : mode === "login" ? "登录" : "注册并登录"}
          </button>
          <p className="auth-foot">
            {mode === "login" ? <>还没有账号？<button type="button" onClick={() => switchMode("register")}>注册一个</button></>
              : <>已经有账号了？<button type="button" onClick={() => switchMode("login")}>去登录</button></>}
          </p>
          <p className="auth-note">账号只存在你本机的后端里，密码加盐哈希保存</p>
        </form>
      </div>
    </div>
  );
}
