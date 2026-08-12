# OfferFlow

OfferFlow 是一个轻量的求职进度管理应用，用表格跟踪投递状态，并把面试安排同步展示在月历中。数据保存在 SQLite，可在本机使用，也可部署为支持多账号的云服务。

## 功能

- 多投递列表管理
- 公司、岗位、日期、状态和备注的行内编辑
- 按进度、公司性质和关键词筛选
- 面试日期、轮次、形式和地点管理
- 面试月历与投递记录联动
- SQLite 持久化、浏览器数据首次迁移和离线兜底
- 应用账号、登录会话和用户数据隔离
- CSV 导出
- 桌面表格与移动端卡片布局

## 快速开始

要求 Python 3.9 或更高版本，不需要安装第三方依赖。

```bash
git clone git@github.com:Smileteeth7/offerflow-job-tracker.git
cd offerflow-job-tracker
python3 server.py
```

打开 [http://localhost:4173](http://localhost:4173)。

首次打开时注册账号。每个账号拥有独立的清单、申请记录、同步版本和浏览器离线缓存。

也可以指定监听地址、端口或数据库路径：

```bash
python3 server.py --host 127.0.0.1 --port 4173 --db ./data/offerflow.db
```

## 使用 Docker

可以在任意支持 Docker 和持久卷的环境运行：

```bash
docker build -t offerflow .
docker run --rm -p 8080:8080 \
  -e OFFERFLOW_USERNAME='offerflow' \
  -e OFFERFLOW_PASSWORD='替换为强密码' \
  -e OFFERFLOW_REGISTRATION_CODE='替换为邀请码' \
  -v offerflow-data:/data \
  offerflow
```

打开 [http://localhost:8080](http://localhost:8080)，使用配置的首个账号登录。`OFFERFLOW_REGISTRATION_CODE` 可选；配置后，新账号注册时必须填写该邀请码。

## 部署到 Ubuntu 云服务器

`deploy/` 包含适用于 Ubuntu 24.04 的 `systemd`、Nginx 和每日 SQLite 备份配置。推荐让 OfferFlow 仅监听 `127.0.0.1:4173`，由 Nginx 在 `80/443` 端口提供公网入口，并使用 Certbot 配置 HTTPS。所有项目实际文件统一位于 `/opt/offerflow`；`/etc/systemd/system`、`/etc/nginx`、`/etc/letsencrypt/renewal-hooks` 和 `/usr/local/sbin` 只保留系统所需的符号链接。

```text
/opt/offerflow/
├── app/                      # 应用代码和备份程序
├── bin/                      # 账号同步命令
├── system/                   # systemd、Nginx 和续期钩子配置
├── acme/                     # HTTPS 证书续期挑战目录
├── data/offerflow.db         # SQLite 数据库
├── backups/                  # 最近 14 天的数据库备份
├── offerflow.env             # 服务环境配置
└── offerflow-users.json      # 账号配置
```

Certbot 管理的证书和续期状态仍位于标准系统目录 `/etc/letsencrypt`；这是 Certbot 的运行数据，不是应用副本。其 Webroot 已指向 `/opt/offerflow/acme`。

### 管理账号

生产服务器可使用受保护的 `/opt/offerflow/offerflow-users.json` 集中管理账号。该文件与 `app`、`data`、`backups` 目录同级，格式参考 `deploy/offerflow-users.example.json`：

```json
{
  "version": 1,
  "users": [
    {
      "key": "owner",
      "username": "shawn",
      "password": "替换为初始密码",
      "enabled": true
    }
  ]
}
```

`key` 是不会对用户展示的稳定标识。保持 `key` 不变即可安全修改用户名或密码，并保留该账号的全部数据。将 `enabled` 改为 `false` 可停止登录并撤销现有会话，但不会删除数据。配置中未列出的既有账号不会被删除。

若所有账号都由管理员分配，请在 `/opt/offerflow/offerflow.env` 中设置 `OFFERFLOW_ALLOW_REGISTRATION=false`，登录页将隐藏自助注册入口。

配置文件必须设为 `root:offerflow`、权限 `660`。普通 SSH 用户不可读取，OfferFlow 服务仅借此权限回写用户修改后的密码哈希。编辑后运行同步命令：

```bash
sudo /opt/offerflow/bin/offerflow-users-sync
```

管理员可在配置中填写一次性明文 `password`，同步后文件会自动改写为 `passwordHash`，数据库也只保存相同的加盐密码哈希。用户可在登录后的工作区修改密码，新哈希会同时回写配置文件；其他设备的会话随即失效。管理员需要重置密码时，将该用户的 `passwordHash` 改回明文 `password` 后再次同步即可。建议为每个人使用不同且不少于 10 位的密码。

新增账号时应填写 `password`，不要手工生成 `passwordHash`。同步工具也会兼容误填在 `passwordHash` 中的普通初始密码，并自动转换为有效哈希。

## 数据存储

默认数据库位于 `data/offerflow.db`，已通过 `.gitignore` 排除，不会被提交到 GitHub。

每个账号的数据行均带有用户归属，读取、写入和版本冲突检查都限定在当前登录用户内。浏览器存储按用户 ID 分区，仅作为后端不可用时的本地兜底。页面重新获得焦点时会检查同一账号在其他设备上的修改，并通过版本号阻止旧页面覆盖较新的数据。

旧版单用户数据库首次启动新版本时，会把原有数据迁移到 `OFFERFLOW_USERNAME` 指定的账号，并使用 `OFFERFLOW_PASSWORD` 设置密码。若未提供密码，首次注册流程会认领原有数据。

备份时可以复制数据库文件，或使用界面中的“导出 CSV”。复制数据库前建议先停止服务。

## 项目结构

```text
.
├── index.html          # 页面结构
├── styles.css          # 视觉与响应式布局
├── app.js              # 前端状态、交互与同步逻辑
├── server.py           # 静态服务与 SQLite JSON API
├── manage_users.py     # 管理员账号配置同步工具
└── tests/
    └── test_server.py  # 数据库读写测试
```

后端提供以下同源接口：

- `GET /api/health`：服务健康检查
- `GET /api/auth/session`：读取当前登录态和注册配置
- `POST /api/auth/login`：登录
- `POST /api/auth/register`：注册
- `POST /api/auth/logout`：退出登录
- `POST /api/auth/password`：修改当前用户密码并回写账号配置
- `GET /api/state`：读取完整应用状态
- `PUT /api/state`：原子写入完整应用状态

## 测试

```bash
python3 -m unittest discover -s tests
node --check app.js
```

## 隐私

密码使用 PBKDF2-SHA256 加盐哈希保存，登录态使用 `HttpOnly`、`SameSite=Lax` Cookie，写操作要求同源校验请求头。生产环境必须使用 HTTPS，并建议配置 `OFFERFLOW_REGISTRATION_CODE`。服务器仅公开三个前端文件，数据库、后端源码和 Git 元数据不会由静态服务器提供。请勿把 `data/offerflow.db`、导出的 CSV 或包含真实会议链接的文件提交到公开仓库。
