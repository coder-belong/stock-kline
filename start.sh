#!/usr/bin/env bash
# 一键启动：后端 8090 + 前端 5200，Ctrl+C 一起停
set -e
cd "$(dirname "$0")"
( cd backend && uv run uvicorn main:app --port 8090 ) &
BACK=$!
trap 'kill $BACK 2>/dev/null' EXIT
cd frontend && npm run dev
