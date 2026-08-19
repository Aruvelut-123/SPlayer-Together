#!/usr/bin/env python3
"""SPlayer Together 中继服务器

职责：
1. 应用授权：客户端按机器 ID 生成密钥，携带密钥询问 ``POST /api/auth``，命中白名单才放行。
2. 一起听中继：房主创建房间，成员加入，房主播放状态经本服务广播给成员实现同步。
3. WebUI 管理后台：登录后管理密钥白名单与房间，管理接口本身需要管理员认证。

配置在 ``config.yml``（监听地址、端口、管理员凭据、密钥白名单）。运行：

    pip install -r requirements.txt
    python server.py
"""

from __future__ import annotations

import secrets
import string
import time
from pathlib import Path
from typing import Any

import yaml
from aiohttp import WSMsgType, web

from webui import render_admin_page

BASE_DIR = Path(__file__).parent
CONFIG_FILE = BASE_DIR / "config.yml"

CODE_ALPHABET = string.ascii_uppercase + string.digits
ROOM_CODE_LEN = 6

DEFAULT_CONFIG: dict[str, Any] = {
    "host": "0.0.0.0",
    "port": 8000,
    "admin": {"username": "admin", "password": "change-me"},
    "keys": [],
}


def now_ms() -> int:
    """服务器毫秒时间戳，用于成员换算进度"""
    return int(time.time() * 1000)


def load_config() -> dict[str, Any]:
    data: dict[str, Any] = {}
    if CONFIG_FILE.exists():
        data = yaml.safe_load(CONFIG_FILE.read_text(encoding="utf-8")) or {}
    config = {**DEFAULT_CONFIG, **data}
    config["admin"] = {**DEFAULT_CONFIG["admin"], **(data.get("admin") or {})}
    config["keys"] = [str(k).strip() for k in (config.get("keys") or []) if str(k).strip()]
    return config


def save_config(config: dict[str, Any]) -> None:
    CONFIG_FILE.write_text(
        yaml.safe_dump(config, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


CONFIG = load_config()
AUTH_KEYS: list[str] = CONFIG["keys"]
ADMIN_USERNAME: str = str(CONFIG["admin"]["username"])
ADMIN_PASSWORD: str = str(CONFIG["admin"]["password"])

# 管理员会话 token 集合
admin_tokens: set[str] = set()

# code -> Room
rooms: dict[str, "Room"] = {}


class Room:
    """一个一起听房间"""

    def __init__(self, code: str, host_id: str):
        self.code = code
        self.host_id = host_id
        # member_id -> {"name", "token", "ws"}
        self.members: dict[str, dict[str, Any]] = {}
        self.state: dict[str, Any] | None = None
        self.seq = 0

    def member_view(self) -> list[dict[str, Any]]:
        return [
            {
                "id": mid,
                "name": m["name"],
                "role": "host" if mid == self.host_id else "guest",
            }
            for mid, m in self.members.items()
            if m["ws"] is not None
        ]

    def online_count(self) -> int:
        return sum(1 for m in self.members.values() if m["ws"] is not None)

    async def broadcast(self, payload: dict[str, Any], exclude: str | None = None) -> None:
        text = json.dumps(payload, ensure_ascii=False)
        for mid, m in self.members.items():
            if m["ws"] is not None and mid != exclude:
                await m["ws"].send_str(text)

    async def broadcast_members(self) -> None:
        await self.broadcast(
            {"type": "members", "members": self.member_view(), "hostId": self.host_id}
        )

    async def broadcast_state(self, exclude: str | None = None) -> None:
        if self.state is None:
            return
        await self.broadcast(
            {
                "type": "state",
                "seq": self.seq,
                "state": self.state,
                "serverNow": now_ms(),
            },
            exclude=exclude,
        )

    async def transfer_host(self) -> bool:
        for mid, m in self.members.items():
            if mid != self.host_id and m["ws"] is not None:
                self.host_id = mid
                await m["ws"].send_str(json.dumps({"type": "role", "role": "host"}))
                return True
        return False

    def admin_view(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "hostId": self.host_id,
            "online": self.online_count(),
            "total": len(self.members),
            "state": self.state,
            "seq": self.seq,
        }


def new_code() -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(ROOM_CODE_LEN))
        if code not in rooms:
            return code


def valid_machine_key(key: str) -> bool:
    return bool(AUTH_KEYS) and key in AUTH_KEYS


def admin_authed(request: web.Request) -> bool:
    token = request.headers.get("X-Admin-Token", "")
    return token in admin_tokens


# --------------------------------------------------------------------------
# CORS：客户端（Electron）与 WebUI 跨域访问需要
# --------------------------------------------------------------------------


@web.middleware
async def cors_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    if request.method == "OPTIONS":
        return web.Response(
            status=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, X-Auth-Key, X-Admin-Token",
            },
        )
    response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response


# --------------------------------------------------------------------------
# 授权
# --------------------------------------------------------------------------


async def handle_auth(request: web.Request) -> web.Response:
    body = await request.json()
    key = str(body.get("key", "")).strip()
    if valid_machine_key(key):
        return web.json_response({"valid": True})
    return web.json_response({"error": "invalid key"}, status=401)


# --------------------------------------------------------------------------
# 一起听房间
# --------------------------------------------------------------------------


async def handle_create(request: web.Request) -> web.Response:
    if not valid_machine_key(request.headers.get("X-Auth-Key", "")):
        return web.json_response({"error": "unauthorized"}, status=401)
    body = await request.json()
    name = str(body.get("name", "")).strip() or "我"
    code = new_code()
    member_id = secrets.token_hex(16)
    token = secrets.token_hex(32)
    room = Room(code, member_id)
    room.members[member_id] = {"name": name, "token": token, "ws": None}
    rooms[code] = room
    return web.json_response({"code": code, "memberId": member_id, "token": token})


async def handle_join(request: web.Request) -> web.Response:
    if not valid_machine_key(request.headers.get("X-Auth-Key", "")):
        return web.json_response({"error": "unauthorized"}, status=401)
    code = request.match_info["code"].strip().upper()
    room = rooms.get(code)
    if room is None:
        return web.json_response({"error": "room not found"}, status=404)
    body = await request.json()
    name = str(body.get("name", "")).strip() or "我"
    member_id = secrets.token_hex(16)
    token = secrets.token_hex(32)
    room.members[member_id] = {"name": name, "token": token, "ws": None}
    return web.json_response({"memberId": member_id, "token": token})


async def handle_ws(request: web.Request) -> web.StreamResponse:
    if not valid_machine_key(request.query.get("key", "")):
        return web.json_response({"error": "unauthorized"}, status=401)

    code = request.match_info["code"].strip().upper()
    room = rooms.get(code)
    if room is None:
        return web.json_response({"error": "room not found"}, status=404)

    ws = web.WebSocketResponse(heartbeat=25)
    await ws.prepare(request)

    member_id: str | None = None
    role = "guest"

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                mtype = data.get("type")

                if mtype == "hello":
                    mid = str(data.get("memberId", ""))
                    token = str(data.get("token", ""))
                    member = room.members.get(mid)
                    if member is None or member["token"] != token:
                        await ws.send_str(json.dumps({"type": "error", "message": "认证失败"}))
                        await ws.close()
                        return ws
                    member_id = mid
                    member["ws"] = ws
                    role = "host" if mid == room.host_id else "guest"
                    await ws.send_str(
                        json.dumps(
                            {
                                "type": "welcome",
                                "code": room.code,
                                "role": role,
                                "members": room.member_view(),
                                "hostId": room.host_id,
                                "state": room.state,
                                "serverNow": now_ms(),
                            },
                            ensure_ascii=False,
                        )
                    )
                    await room.broadcast_members()

                elif mtype == "state" and member_id is not None:
                    if member_id != room.host_id:
                        continue
                    room.seq += 1
                    room.state = {
                        "track": data.get("track"),
                        "state": data.get("state"),
                        "positionMs": int(data.get("positionMs", 0)),
                        "at": now_ms(),
                    }
                    await room.broadcast_state(exclude=member_id)

                elif mtype == "report" and member_id is not None:
                    host = room.members.get(room.host_id)
                    if host is not None and host["ws"] is not None:
                        await host["ws"].send_str(
                            json.dumps(
                                {
                                    "type": "event",
                                    "kind": "loadFailed",
                                    "name": room.members.get(member_id, {}).get("name", "成员"),
                                    "trackTitle": str(data.get("trackTitle", "")),
                                },
                                ensure_ascii=False,
                            )
                        )

                elif mtype == "ping":
                    await ws.send_str(json.dumps({"type": "pong"}))

                elif mtype == "leave":
                    break

            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        if member_id is not None and member_id in room.members:
            room.members.pop(member_id, None)
            if member_id == room.host_id:
                if await room.transfer_host():
                    await room.broadcast_members()
                else:
                    rooms.pop(room.code, None)
            else:
                await room.broadcast_members()
        if room.code in rooms and not room.members:
            rooms.pop(room.code, None)

    return ws


# --------------------------------------------------------------------------
# WebUI 管理后台
# --------------------------------------------------------------------------


async def handle_admin_login(request: web.Request) -> web.Response:
    body = await request.json()
    username = str(body.get("username", ""))
    password = str(body.get("password", ""))
    if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
        token = secrets.token_hex(32)
        admin_tokens.add(token)
        return web.json_response({"token": token})
    return web.json_response({"error": "invalid credentials"}, status=401)


async def handle_admin_logout(request: web.Request) -> web.Response:
    admin_tokens.discard(request.headers.get("X-Admin-Token", ""))
    return web.json_response({"ok": True})


async def handle_admin_keys_list(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    return web.json_response({"keys": list(AUTH_KEYS)})


async def handle_admin_keys_add(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    body = await request.json()
    key = str(body.get("key", "")).strip()
    if not key:
        return web.json_response({"error": "empty key"}, status=400)
    if key not in AUTH_KEYS:
        AUTH_KEYS.append(key)
        save_config(CONFIG)
    return web.json_response({"keys": list(AUTH_KEYS)})


async def handle_admin_keys_remove(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    key = request.match_info["key"]
    if key in AUTH_KEYS:
        AUTH_KEYS.remove(key)
        save_config(CONFIG)
    return web.json_response({"keys": list(AUTH_KEYS)})


async def handle_admin_rooms_list(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    return web.json_response({"rooms": [r.admin_view() for r in rooms.values()]})


async def handle_admin_room_dissolve(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    code = request.match_info["code"].strip().upper()
    room = rooms.get(code)
    if room is None:
        return web.json_response({"error": "room not found"}, status=404)
    for m in room.members.values():
        if m["ws"] is not None:
            await m["ws"].close()
    rooms.pop(code, None)
    return web.json_response({"ok": True})


async def handle_admin_page(request: web.Request) -> web.StreamResponse:
    return web.Response(text=render_admin_page(), content_type="text/html")


async def index(_request: web.Request) -> web.Response:
    return web.Response(text="SPlayer Together relay server")


def build_app() -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get("/", index)
    app.router.add_get("/admin", handle_admin_page)
    app.router.add_post("/api/auth", handle_auth)
    app.router.add_post("/api/rooms", handle_create)
    app.router.add_post("/api/rooms/{code}/join", handle_join)
    app.router.add_get("/api/rooms/{code}/ws", handle_ws)
    app.router.add_post("/api/admin/login", handle_admin_login)
    app.router.add_post("/api/admin/logout", handle_admin_logout)
    app.router.add_get("/api/admin/keys", handle_admin_keys_list)
    app.router.add_post("/api/admin/keys", handle_admin_keys_add)
    app.router.add_delete("/api/admin/keys/{key}", handle_admin_keys_remove)
    app.router.add_get("/api/admin/rooms", handle_admin_rooms_list)
    app.router.add_post("/api/admin/rooms/{code}/dissolve", handle_admin_room_dissolve)
    return app


def main() -> None:
    if not AUTH_KEYS:
        print("[warn] 密钥白名单为空：请在 config.yml 或 WebUI 中配置，未授权客户端将被拒绝")
    if ADMIN_PASSWORD == "change-me":
        print("[warn] 管理后台仍在使用默认密码，请尽快在 config.yml 中修改")
    host = str(CONFIG["host"])
    port = int(CONFIG["port"])
    print(f"[info] 已加载 {len(AUTH_KEYS)} 个密钥")
    print(f"[info] 监听 http://{host}:{port}，管理后台 http://{host}:{port}/admin")
    web.run_app(build_app(), host=host, port=port)


if __name__ == "__main__":
    main()
