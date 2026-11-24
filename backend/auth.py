"""账号：注册、登录、退出、当前用户。

- 密码：标准库 hashlib.scrypt 加盐哈希，库里只存「scrypt$盐$哈希」，不存明文。
- 登录态：JWT（HS256，30 天）放在 HttpOnly Cookie「sk_token」里，前端 JS 读不到，防 XSS 偷 token。
  前端经 Next 的 /api 代理访问后端，同源，Cookie 自动带上。
- 签名密钥：本机第一次启动时随机生成，存在 backend/data/secret.key（已在 .gitignore）；部署时必须用环境变量 SK_JWT_SECRET。
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
from pathlib import Path
from typing import Annotated

import jwt
import psycopg
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel, Field

import db

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE = "sk_token"
TOKEN_DAYS = 30
DEFAULT_CASH = 100_000.0
USERNAME_RE = re.compile(r"^[A-Za-z0-9_一-龥]{2,20}$")


def _secret() -> str:
    if os.environ.get("SK_JWT_SECRET"):
        return os.environ["SK_JWT_SECRET"]
    if os.environ.get("VERCEL"):  # Vercel 上文件写不住，每个实例会各生成一个密钥，登录态就乱了
        raise RuntimeError("Vercel 上必须配置环境变量 SK_JWT_SECRET")
    p = Path(__file__).parent / "data" / "secret.key"
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(secrets.token_hex(32))
        p.chmod(0o600)
    return p.read_text().strip()


SECRET = _secret()


# ---------- 密码 ----------
def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${h.hex()}"


def check_password(pw: str, stored: str) -> bool:
    try:
        _, salt, h = stored.split("$")
    except ValueError:
        return False
    got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1)
    return hmac.compare_digest(got.hex(), h)


# ---------- token ----------
def make_token(user_id: int, username: str) -> str:
    now = int(time.time())
    return jwt.encode({"sub": str(user_id), "name": username, "iat": now, "exp": now + TOKEN_DAYS * 86400}, SECRET, "HS256")


# 本机是 http，secure 关着；Vercel 上是 https，自动打开（只走 https 发送）
SECURE = bool(os.environ.get("VERCEL")) or os.environ.get("SK_SECURE_COOKIE") == "1"


def _set_cookie(resp: Response, token: str) -> None:
    resp.set_cookie(COOKIE, token, max_age=TOKEN_DAYS * 86400, httponly=True, samesite="lax", path="/", secure=SECURE)


class User(BaseModel):
    id: int
    username: str


def current_user(sk_token: Annotated[str | None, Cookie()] = None) -> User:
    """依赖：要登录的接口用它。没登录或 token 无效 → 401。"""
    if not sk_token:
        raise HTTPException(401, "请先登录")
    try:
        p = jwt.decode(sk_token, SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError as e:
        raise HTTPException(401, "登录已过期，请重新登录") from e
    except jwt.InvalidTokenError as e:
        raise HTTPException(401, "请先登录") from e
    with db.conn() as c:
        row = c.execute("select id, username from users where id=%s", (int(p["sub"]),)).fetchone()
    if row is None:
        raise HTTPException(401, "账号不存在，请重新登录")
    return User(id=row["id"], username=row["username"])


CurrentUser = Annotated[User, Depends(current_user)]


# ---------- 接口 ----------
class Credentials(BaseModel):
    username: str = Field(min_length=2, max_length=20)
    password: str = Field(min_length=6, max_length=72)


@router.post("/register", response_model=User, status_code=201)
def register(body: Credentials, resp: Response) -> User:
    name = body.username.strip()
    if not USERNAME_RE.match(name):
        raise HTTPException(400, "用户名 2～20 位，只能用中英文、数字、下划线")
    with db.conn() as c:
        if c.execute("select 1 from users where lower(username)=lower(%s)", (name,)).fetchone():
            raise HTTPException(409, "这个用户名已经被注册了")
        try:
            uid = c.execute("insert into users (username, password_hash, created_at) values (%s, %s, %s) returning id",
                            (name, hash_password(body.password), db.now())).fetchone()["id"]
        except psycopg.errors.UniqueViolation as e:  # 两个人同时注册同一个名字
            raise HTTPException(409, "这个用户名已经被注册了") from e
        c.execute("insert into accounts values (%s, %s, %s, %s)", (uid, DEFAULT_CASH, DEFAULT_CASH, db.now()))
        c.commit()
    _set_cookie(resp, make_token(uid, name))
    return User(id=uid, username=name)


LOGIN_MAX_FAILS = 10         # 同一个用户名 15 分钟内最多错 10 次，防撞库
LOGIN_WINDOW_S = 15 * 60


@router.post("/login", response_model=User)
def login(body: Credentials, resp: Response) -> User:
    name = body.username.strip().lower()
    since = int(time.time()) - LOGIN_WINDOW_S
    with db.conn() as c:
        fails = c.execute("select count(*) n from login_fails where username=%s and ts>%s", (name, since)).fetchone()["n"]
        if fails >= LOGIN_MAX_FAILS:
            raise HTTPException(429, "密码错太多次了，过 15 分钟再试")
        row = c.execute("select id, username, password_hash from users where lower(username)=%s", (name,)).fetchone()
        # 用户不存在和密码错用同一句话，不暴露哪些用户名存在
        if row is None or not check_password(body.password, row["password_hash"]):
            c.execute("insert into login_fails values (%s, %s)", (name, int(time.time())))
            c.execute("delete from login_fails where ts<%s", (since,))
            c.commit()
            raise HTTPException(401, "用户名或密码不对")
    _set_cookie(resp, make_token(row["id"], row["username"]))
    return User(id=row["id"], username=row["username"])


@router.post("/logout", status_code=204)
def logout(resp: Response) -> Response:
    resp.delete_cookie(COOKIE, path="/", secure=SECURE, httponly=True, samesite="lax")
    resp.status_code = 204
    return resp


@router.get("/me", response_model=User)
def me(user: CurrentUser) -> User:
    return user
