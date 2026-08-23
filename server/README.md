# SPlayer Together 中继服务器

一起听（Listen Together）房间同步的中继服务器，用 Python + aiohttp 编写，自带 WebUI 管理后台。
一起听同步全部走**纯 HTTP 轮询**（房主推送、成员拉取），不使用 WebSocket，部署简单且不易断线。

## 运行

```bash
pip install -r requirements.txt
python server.py
```

首次运行前，从示例复制一份配置文件：

```bash
cp config.example.yml config.yml
```

默认监听 `0.0.0.0:8000`。

运行测试：

```bash
python -m pytest test_server.py -v
```

## 日志

服务器使用 Python 标准库 `logging` 输出到标准输出（适合 Docker 用 `docker logs` 查看），
格式为 `时间 [级别] 模块: 消息`。可用环境变量 `LOG_LEVEL` 调整级别
（`DEBUG` / `INFO` / `WARNING` / `ERROR`，默认 `INFO`）。

- `INFO`：房间创建 / 加入 / 离开 / 解散、管理员登录等关键事件
- `DEBUG`：房主状态与队列推送等高频动作（默认关闭，避免刷屏）
- `WARNING`：房主失联转移、管理员解散房间、仍在使用默认密码等

## 配置（config.yml）

```yaml
host: 0.0.0.0
port: 8000
admin:
  username: admin      # WebUI 登录用户名
  password: change-me  # WebUI 登录密码，务必修改
```

> `config.yml` 已被 `.gitignore` 忽略，不会提交到仓库，避免泄露管理员凭据。

## WebUI 管理后台

启动后访问 `http://<服务器>:8000/admin`，用 `config.yml` 中的管理员账号登录，可：

- 查看进行中的房间（房主、在线人数、当前曲目）
- 一键解散房间

WebUI 与所有管理接口都需要管理员登录（session token）后才能使用。

## 接口

房间操作需携带成员请求头：`X-Member-Id` + `X-Token`
（创建 / 加入成功后由服务器返回这两个值）。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/api/rooms` | 创建一起听房间（房主），body `{"name": "昵称"}` |
| POST | `/api/rooms/{code}/join` | 加入房间，body `{"name": "昵称"}` |
| POST | `/api/rooms/{code}/state` | 推送播放状态（房主/获权成员），body 含 `track/state/positionMs/playIndex/repeatMode/shuffleMode`，可选 `baseSeq` 乐观锁 |
| GET | `/api/rooms/{code}/state` | 拉取房间快照（状态 / 成员 / 队列 / 报告 / 权限） |
| POST | `/api/rooms/{code}/queue` | 推送播放列表，body `{"tracks": [...]}` |
| POST | `/api/rooms/{code}/permissions` | 房主设置成员权限（全局或 per-member） |
| POST | `/api/rooms/{code}/transfer` | 房主将房主身份转移给其他成员 |
| POST | `/api/rooms/{code}/report` | 成员上报无法播放，房主下次拉取时收到 |
| POST | `/api/rooms/{code}/leave` | 离开房间（房主离开自动转移房主） |
| POST | `/api/admin/login` | 管理员登录，返回 token |
| POST | `/api/admin/logout` | 管理员退出登录 |
| POST | `/api/admin/reload` | 重新加载 `config.yml`，需 `X-Admin-Token` |
| GET | `/api/admin/rooms` | 房间列表（仅进行中的房间），需 `X-Admin-Token` |
| POST | `/api/admin/rooms/{code}/dissolve` | 解散房间，需 `X-Admin-Token` |

## 同步协议与乐观锁

- 客户端每 **500ms** 拉取一次房间快照；房主同时每 500ms 推送一次位置（兼作心跳）。
- 推送携带 `baseSeq`（客户端已知的服务器序号）做**乐观锁**：客户端序号落后于服务器序号且
  最后推送者不是自己时，服务器拒绝覆盖，返回 `{conflict: true, snapshot}`，客户端据此跟随最新状态。
- 获权成员（`allowGuestControl`）可推送状态抢占权威；无权限成员始终强制跟随房主。

## 房间生命周期

- 成员超过 60 秒未请求视为离线（不计入在线人数）。
- 房主超过 20 秒未推送视为失联，服务器自动把房主转移给在线成员。
- 无在线成员的房间超过 2 分钟后由后台任务自动清理，不留僵尸房间。
- 解散 / 清理前会标记 `closed`，让客户端在下一次轮询时优雅退出房间。