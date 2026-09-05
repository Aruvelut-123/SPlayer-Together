"""SPlayer Together 中继服务器测试：房间全生命周期 + 服务器自更新"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

# 在导入 server 之前重置 rooms 和 admin_tokens 以确保测试隔离
import server as relay

relay.rooms = {}
relay.admin_tokens = set()


class TestRoomLifecycle(AioHTTPTestCase):
    """房间创建、加入、状态推拉、房主转移、解散"""

    async def get_application(self):
        return relay.build_app()

    async def _create_room(self) -> dict[str, Any]:
        resp = await self.client.post("/api/rooms", json={"name": "HostOne"})
        assert resp.status == 200
        data = await resp.json()
        assert "code" in data
        assert "memberId" in data
        assert "token" in data
        return data

    async def _join_room(self, code: str, name: str = "GuestOne") -> dict[str, Any]:
        resp = await self.client.post(f"/api/rooms/{code}/join", json={"name": name})
        assert resp.status == 200
        data = await resp.json()
        assert "memberId" in data
        assert "token" in data
        return data

    def _headers(self, member_id: str, token: str) -> dict[str, str]:
        return {"X-Member-Id": member_id, "X-Token": token}

    @unittest_run_loop
    async def test_create_room(self):
        """创建房间应返回房间码、成员 ID 和令牌"""
        data = await self._create_room()
        assert len(data["code"]) == 6
        assert data["code"].isalnum()
        assert len(data["memberId"]) == 32
        assert len(data["token"]) == 64

    @unittest_run_loop
    async def test_join_room(self):
        """加入房间应返回成员 ID 和令牌"""
        room = await self._create_room()
        guest = await self._join_room(room["code"])
        assert len(guest["memberId"]) == 32
        assert len(guest["token"]) == 64

    @unittest_run_loop
    async def test_join_nonexistent_room_returns_404(self):
        """加入不存在的房间应返回 404"""
        resp = await self.client.post("/api/rooms/ZZZZZZ/join", json={"name": "Ghost"})
        assert resp.status == 404
        data = await resp.json()
        assert "error" in data

    @unittest_run_loop
    async def test_host_push_and_guest_pull_state(self):
        """房主推状态后，成员应能拉取到该状态"""
        room = await self._create_room()
        host_headers = self._headers(room["memberId"], room["token"])

        push_resp = await self.client.post(
            f"/api/rooms/{room['code']}/state",
            json={
                "track": {"id": "123", "title": "Test Song"},
                "state": "playing",
                "positionMs": 5000,
                "playIndex": 0,
                "repeatMode": "list",
                "shuffleMode": "off",
            },
            headers=host_headers,
        )
        assert push_resp.status == 200
        push_data = await push_resp.json()
        assert push_data["seq"] > 0
        assert push_data["state"]["track"]["title"] == "Test Song"

        # 成员加入并拉取
        guest = await self._join_room(room["code"])
        guest_headers = self._headers(guest["memberId"], guest["token"])
        get_resp = await self.client.get(
            f"/api/rooms/{room['code']}/state", headers=guest_headers
        )
        assert get_resp.status == 200
        get_data = await get_resp.json()
        assert get_data["state"]["track"]["title"] == "Test Song"
        assert get_data["state"]["state"] == "playing"

    @unittest_run_loop
    async def test_unauthorized_get_state_returns_401(self):
        """未授权拉取状态应返回 401"""
        resp = await self.client.get(
            "/api/rooms/AAAAAA/state",
            headers={"X-Member-Id": "bad", "X-Token": "bad"},
        )
        assert resp.status == 401

    @unittest_run_loop
    async def test_guest_push_disabled_when_control_disabled(self):
        """获权控制被禁用后，成员推送状态应返回 403"""
        room = await self._create_room()
        host_headers = self._headers(room["memberId"], room["token"])
        guest = await self._join_room(room["code"])
        guest_headers = self._headers(guest["memberId"], guest["token"])

        # 房主禁用该成员的推送权限
        await self.client.post(
            f"/api/rooms/{room['code']}/permissions",
            json={"memberId": guest["memberId"], "allowGuestControl": False},
            headers=host_headers,
        )

        push_resp = await self.client.post(
            f"/api/rooms/{room['code']}/state",
            json={"state": "playing", "positionMs": 0, "playIndex": 0},
            headers=guest_headers,
        )
        assert push_resp.status == 403

    @unittest_run_loop
    async def test_optimistic_lock_conflict(self):
        """乐观锁：baseSeq 落后时返回冲突快照"""
        room = await self._create_room()
        host_headers = self._headers(room["memberId"], room["token"])

        # 两次推送使 seq=2
        await self.client.post(
            f"/api/rooms/{room['code']}/state",
            json={"state": "playing", "positionMs": 1000, "playIndex": 0},
            headers=host_headers,
        )
        await self.client.post(
            f"/api/rooms/{room['code']}/state",
            json={"state": "playing", "positionMs": 1500, "playIndex": 0},
            headers=host_headers,
        )

        # 当前 seq=2，baseSeq=1（落后），且 last_actor 不是自己时触发冲突
        relay.rooms[room["code"]].last_actor = "someone_else"

        push_resp = await self.client.post(
            f"/api/rooms/{room['code']}/state",
            json={
                "state": "paused",
                "positionMs": 2000,
                "playIndex": 0,
                "baseSeq": 1,
            },
            headers=host_headers,
        )
        assert push_resp.status == 200
        push_data = await push_resp.json()
        assert push_data.get("conflict") is True
        assert "snapshot" in push_data

    @unittest_run_loop
    async def test_push_queue(self):
        """房主推送播放列表"""
        room = await self._create_room()
        host_headers = self._headers(room["memberId"], room["token"])
        tracks = [{"id": "1", "title": "Track A"}, {"id": "2", "title": "Track B"}]

        resp = await self.client.post(
            f"/api/rooms/{room['code']}/queue",
            json={"tracks": tracks},
            headers=host_headers,
        )
        assert resp.status == 200
        data = await resp.json()
        assert len(data["queue"]) == 2

    @unittest_run_loop
    async def test_leave_room(self):
        """成员离开房间"""
        room = await self._create_room()
        guest = await self._join_room(room["code"])
        guest_headers = self._headers(guest["memberId"], guest["token"])

        resp = await self.client.post(
            f"/api/rooms/{room['code']}/leave", headers=guest_headers
        )
        assert resp.status == 200
        data = await resp.json()
        assert data["ok"] is True

    @unittest_run_loop
    async def test_transfer_host(self):
        """房主转移"""
        room = await self._create_room()
        guest = await self._join_room(room["code"])
        host_headers = self._headers(room["memberId"], room["token"])

        resp = await self.client.post(
            f"/api/rooms/{room['code']}/transfer",
            json={"targetMemberId": guest["memberId"]},
            headers=host_headers,
        )
        assert resp.status == 200
        data = await resp.json()
        assert data["hostId"] == guest["memberId"]

    @unittest_run_loop
    async def test_admin_rooms_list(self):
        """管理员列出房间"""
        await self._create_room()
        await self._create_room()

        # 模拟登录
        login_resp = await self.client.post(
            "/api/admin/login",
            json={"username": "admin", "password": "change-me"},
        )
        assert login_resp.status == 200
        login_data = await login_resp.json()
        token = login_data["token"]

        rooms_resp = await self.client.get(
            "/api/admin/rooms",
            headers={"X-Admin-Token": token},
        )
        assert rooms_resp.status == 200
        rooms_data = await rooms_resp.json()
        assert len(rooms_data["rooms"]) >= 2

    @unittest_run_loop
    async def test_admin_dissolve_room(self):
        """管理员解散房间"""
        room = await self._create_room()

        login_resp = await self.client.post(
            "/api/admin/login",
            json={"username": "admin", "password": "change-me"},
        )
        login_data = await login_resp.json()
        token = login_data["token"]

        resp = await self.client.post(
            f"/api/admin/rooms/{room['code']}/dissolve",
            headers={"X-Admin-Token": token},
        )
        assert resp.status == 200
        data = await resp.json()
        assert data["ok"] is True

    @unittest_run_loop
    async def test_report_then_clear_on_snapshot(self):
        """成员报告在快照中取出后清空"""
        room = await self._create_room()
        host_headers = self._headers(room["memberId"], room["token"])

        await self.client.post(
            f"/api/rooms/{room['code']}/report",
            json={"kind": "error", "name": "HostOne", "trackTitle": "Test"},
            headers=host_headers,
        )

        # 第一次拉取应有报告
        get1 = await self.client.get(
            f"/api/rooms/{room['code']}/state", headers=host_headers
        )
        data1 = await get1.json()
        assert len(data1["reports"]) == 1

        # 第二次拉取报告应清空
        get2 = await self.client.get(
            f"/api/rooms/{room['code']}/state", headers=host_headers
        )
        data2 = await get2.json()
        assert len(data2["reports"]) == 0


@pytest.fixture
def update_env(tmp_path, monkeypatch):
    """将更新路径重定向到临时目录"""
    for name in relay.UPDATE_FILES:
        (tmp_path / name).write_text("old " + name, encoding="utf-8")
    changelogs = tmp_path / "changelogs"
    changelogs.mkdir()
    (changelogs / "1.2.0.md").write_text("# 1.2.0\n\n- 自更新\n", encoding="utf-8")
    monkeypatch.setattr(relay, "BASE_DIR", tmp_path)
    monkeypatch.setattr(relay, "UPDATE_STAGING_DIR", tmp_path / ".update-staging")
    monkeypatch.setattr(relay, "BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(relay, "UPDATE_STATE_FILE", tmp_path / "update-state.json")
    monkeypatch.setattr(relay, "CHANGELOGS_DIR", changelogs)
    monkeypatch.setattr(relay, "CONFIG", {**relay.DEFAULT_CONFIG, "update": {**relay.DEFAULT_CONFIG["update"], "enabled": True, "github_repo": "foo/bar"}})
    monkeypatch.setattr(relay, "UPDATE_STATE", {**relay.UPDATE_STATE, "status": "idle", "latestVersion": "", "tagName": "", "stagedFiles": [], "error": ""})
    restarts = []
    monkeypatch.setattr(relay, "schedule_restart", lambda delay_s=1.0: restarts.append(delay_s))
    return tmp_path, restarts


async def _admin_headers(client):
    resp = await client.post("/api/admin/login", json={"username": "admin", "password": "change-me"})
    return {"X-Admin-Token": (await resp.json())["token"]}


@pytest.mark.asyncio
async def test_version_endpoint_public(aiohttp_client, update_env):
    client = await aiohttp_client(relay.build_app())
    data = await (await client.get("/api/version")).json()
    assert data["version"] == relay.SERVER_VERSION


@pytest.mark.asyncio
async def test_update_check_and_status(aiohttp_client, update_env, monkeypatch):
    async def latest():
        return {"version": "9.9.9", "tagName": "v9.9.9", "releaseUrl": "", "releaseName": "", "releaseNotes": ""}
    monkeypatch.setattr(relay, "fetch_latest_release", latest)
    client = await aiohttp_client(relay.build_app())
    headers = await _admin_headers(client)
    resp = await client.post("/api/admin/update/check", headers=headers)
    assert resp.status == 200
    assert (await resp.json())["status"] == "available"


@pytest.mark.asyncio
async def test_update_apply_validates_and_backs_up(aiohttp_client, update_env, monkeypatch):
    root, restarts = update_env
    async def latest():
        return {"version": "9.9.9", "tagName": "v9.9.9", "releaseUrl": "", "releaseName": "", "releaseNotes": ""}
    async def raw(name, tag):
        if name == "server.py": return 'SERVER_VERSION = "9.9.9"\n'
        if name == "webui.py": return 'PAGE_HTML = "ok"\n'
        return "aiohttp>=3.9\n"
    monkeypatch.setattr(relay, "fetch_latest_release", latest)
    monkeypatch.setattr(relay, "fetch_raw_text", raw)
    client = await aiohttp_client(relay.build_app())
    resp = await client.post("/api/admin/update/apply", headers=await _admin_headers(client))
    assert resp.status == 200, await resp.text()
    assert (await resp.json())["status"] == "installed"
    assert '9.9.9' in (root / "server.py").read_text(encoding="utf-8")
    assert restarts == [1.0]
    assert list((root / "backups").iterdir())


@pytest.mark.asyncio
async def test_changelog_admin(aiohttp_client, update_env):
    client = await aiohttp_client(relay.build_app())
    headers = await _admin_headers(client)
    resp = await client.get("/api/admin/update/changelog?version=1.2.0", headers=headers)
    assert resp.status == 200
    assert "自更新" in (await resp.json())["markdown"]


def release_file(name: str, version: str = "9.9.9") -> str:
    """构造可通过校验的假发布文件"""
    if name == "server.py":
        return f'SERVER_VERSION = "{version}"\n\n\ndef handle_create():\n    return None\n'
    if name == "webui.py":
        return 'PAGE_HTML = "<html></html>"\n'
    return "aiohttp>=3.9\npyyaml>=6.0  # 依赖\n"


@pytest.mark.asyncio
async def test_update_status_requires_admin(aiohttp_client, update_env):
    client = await aiohttp_client(relay.build_app())
    assert (await client.get("/api/admin/update/status")).status == 401
    assert (await client.post("/api/admin/update/check")).status == 401
    assert (await client.post("/api/admin/update/apply")).status == 401
    assert (await client.post("/api/admin/update/restart")).status == 401


@pytest.mark.asyncio
async def test_apply_update_rejects_invalid_download(aiohttp_client, update_env, monkeypatch):
    """下载文件校验失败时不替换任何文件，也不重启"""
    root, restarts = update_env

    async def latest():
        return {"version": "9.9.9", "tagName": "v9.9.9", "releaseUrl": "", "releaseName": "", "releaseNotes": ""}

    async def raw(name: str, tag: str) -> str:
        if name == "webui.py":
            return "def broken(:\n"
        return release_file(name)

    monkeypatch.setattr(relay, "fetch_latest_release", latest)
    monkeypatch.setattr(relay, "fetch_raw_text", raw)
    client = await aiohttp_client(relay.build_app())
    resp = await client.post("/api/admin/update/apply", headers=await _admin_headers(client))
    assert resp.status == 400
    assert "语法校验失败" in (await resp.json())["error"]
    assert "old webui.py" in (root / "webui.py").read_text(encoding="utf-8")
    assert not (root / "backups").exists()
    assert restarts == []
    assert relay.UPDATE_STATE["status"] == "error"


@pytest.mark.asyncio
async def test_apply_update_requires_enabled(aiohttp_client, update_env, monkeypatch):
    monkeypatch.setattr(relay, "CONFIG", {**relay.CONFIG, "update": {**relay.CONFIG["update"], "enabled": False}})
    client = await aiohttp_client(relay.build_app())
    resp = await client.post("/api/admin/update/apply", headers=await _admin_headers(client))
    assert resp.status == 400
    assert "未启用" in (await resp.json())["error"]


@pytest.mark.asyncio
async def test_apply_update_requires_repo(aiohttp_client, update_env, monkeypatch):
    monkeypatch.setattr(relay, "CONFIG", {**relay.CONFIG, "update": {**relay.CONFIG["update"], "github_repo": ""}})
    client = await aiohttp_client(relay.build_app())
    resp = await client.post("/api/admin/update/apply", headers=await _admin_headers(client))
    assert resp.status == 400
    assert "github_repo" in (await resp.json())["error"]


@pytest.mark.asyncio
async def test_restart_endpoint_only_schedules(aiohttp_client, update_env):
    """重启接口先返回响应，再安排重启"""
    _root, restarts = update_env
    client = await aiohttp_client(relay.build_app())
    resp = await client.post("/api/admin/update/restart", headers=await _admin_headers(client))
    assert resp.status == 200
    data = await resp.json()
    assert data["ok"] is True and "重启" in data["message"]
    assert restarts == [1.0]


@pytest.mark.asyncio
async def test_changelog_rejects_bad_version(aiohttp_client, update_env):
    client = await aiohttp_client(relay.build_app())
    headers = await _admin_headers(client)
    assert (await client.get("/api/admin/update/changelog?version=../../etc/passwd", headers=headers)).status == 400


@pytest.mark.asyncio
async def test_changelog_missing_everywhere(aiohttp_client, update_env, monkeypatch):
    async def raw(name: str, tag: str) -> str:
        raise relay.UpdateError("下载 失败：HTTP 404")

    monkeypatch.setattr(relay, "fetch_raw_text", raw)
    client = await aiohttp_client(relay.build_app())
    headers = await _admin_headers(client)
    resp = await client.get("/api/admin/update/changelog?version=8.8.8", headers=headers)
    assert resp.status == 404


def test_version_comparisons():
    assert relay.version_is_newer("v1.2.1", "1.2.0")
    assert relay.version_is_newer("1.10", "1.2.0")
    assert not relay.version_is_newer("1.2.0", "1.2.0")
    assert not relay.version_is_newer("1.1.9", "1.2.0")
    assert relay.parse_version("1.2.3-beta.1") == (1, 2, 3)
    assert relay.parse_version("nightly") is None


def test_validate_release_file_rules():
    for name in relay.UPDATE_FILES:
        relay.validate_release_file(name, release_file(name), "9.9.9")
    with pytest.raises(relay.UpdateError):
        relay.validate_release_file("server.py", "   ", "9.9.9")
    with pytest.raises(relay.UpdateError):
        relay.validate_release_file("server.py", "print(1)\n", "9.9.9")
    with pytest.raises(relay.UpdateError):
        relay.validate_release_file("requirements.txt", "aiohttp>=3.9\n!!!\n", "9.9.9")


def test_update_config_aliases(monkeypatch):
    """支持 repo / check_interval 简写"""
    monkeypatch.setattr(relay, "CONFIG", {"update": {"repo": "foo/bar", "check_interval": 15}})
    assert relay.update_cfg_str("github_repo") == "foo/bar"
    assert relay.update_cfg_int("check_interval_minutes", 60) == 15


def test_staged_path_rejects_unknown_file():
    assert relay.staged_path("server.py").name == "server.py"
    for bad in ("../server.py", "config.yml", ""):
        with pytest.raises(relay.UpdateError):
            relay.staged_path(bad)


def test_save_and_restore_update_state(tmp_path, monkeypatch):
    """待安装状态可持久化并在重启后恢复"""
    staging = tmp_path / ".update-staging"
    staging.mkdir()
    for name in relay.UPDATE_FILES:
        (staging / name).write_text(release_file(name), encoding="utf-8")
    monkeypatch.setattr(relay, "UPDATE_STAGING_DIR", staging)
    monkeypatch.setattr(relay, "UPDATE_STATE_FILE", tmp_path / "update-state.json")
    monkeypatch.setattr(
        relay,
        "UPDATE_STATE",
        {
            **relay.UPDATE_STATE,
            "status": "ready",
            "latestVersion": "9.9.9",
            "tagName": "v9.9.9",
            "stagedFiles": list(relay.UPDATE_FILES),
            "checkedAt": 123,
        },
    )

    relay.save_update_state()
    saved = json.loads((tmp_path / "update-state.json").read_text(encoding="utf-8"))
    assert saved["latestVersion"] == "9.9.9"

    monkeypatch.setattr(
        relay,
        "UPDATE_STATE",
        {**relay.UPDATE_STATE, "status": "idle", "latestVersion": "", "tagName": "", "stagedFiles": []},
    )
    relay.restore_update_state()
    assert relay.UPDATE_STATE["status"] == "ready"
    assert relay.UPDATE_STATE["latestVersion"] == "9.9.9"


def test_restore_update_state_drops_stale_file(tmp_path, monkeypatch):
    """暂存文件缺失时丢弃待安装状态"""
    monkeypatch.setattr(relay, "UPDATE_STAGING_DIR", tmp_path / ".update-staging")
    monkeypatch.setattr(relay, "UPDATE_STATE_FILE", tmp_path / "update-state.json")
    (tmp_path / "update-state.json").write_text(
        json.dumps({"latestVersion": "9.9.9", "tagName": "v9.9.9", "stagedFiles": list(relay.UPDATE_FILES)}),
        encoding="utf-8",
    )
    relay.restore_update_state()
    assert relay.UPDATE_STATE["status"] == "idle"
    assert not (tmp_path / "update-state.json").exists()


def test_update_check_loop_keeps_running(update_env, monkeypatch):
    """后台检查任务出错后继续按间隔重试"""
    calls: list[int] = []

    async def fake_check():
        calls.append(1)
        raise relay.UpdateError("模拟检查失败")

    async def fake_sleep(seconds):
        if calls:
            raise asyncio.CancelledError

    monkeypatch.setattr(relay, "check_for_update", fake_check)
    monkeypatch.setattr(relay, "UPDATE_STARTUP_CHECK_DELAY_S", 0)
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(relay.update_check_loop())
    assert calls == [1]
