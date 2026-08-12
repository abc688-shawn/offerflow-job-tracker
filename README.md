# OfferFlow

OfferFlow 是一个轻量的求职进度管理应用，用表格跟踪投递状态，并把面试安排同步展示在月历中。数据保存在 SQLite，可在本机使用，也可部署为受密码保护的个人云服务。

## 功能

- 多投递列表管理
- 公司、岗位、日期、状态和备注的行内编辑
- 按进度、公司性质和关键词筛选
- 面试日期、轮次、形式和地点管理
- 面试月历与投递记录联动
- SQLite 持久化、浏览器数据首次迁移和离线兜底
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

也可以指定监听地址、端口或数据库路径：

```bash
python3 server.py --host 127.0.0.1 --port 4173 --db ./data/offerflow.db
```

## 部署到 Railway

仓库包含生产用 `Dockerfile` 和 `railway.toml`。部署时必须同时配置持久卷和访问密码，否则 SQLite 数据会在重新部署时丢失，或服务会拒绝在公网启动。

1. 在 Railway 新建项目，选择 **Deploy from GitHub repo** 并连接本仓库。
2. 给 Web Service 添加 Volume，Mount Path 填写 `/data`。
3. 在 Variables 中添加 `OFFERFLOW_PASSWORD`，使用唯一的强密码。可选添加 `OFFERFLOW_USERNAME`，默认用户名为 `offerflow`。
4. 在服务 Settings 的 Networking 中生成公网域名。健康检查使用 `/api/health`，容器会自动读取 Railway 提供的 `PORT`。

访问域名时浏览器会要求输入用户名和密码。应用只应运行一个副本，因为单个 SQLite 持久卷不能由多个服务副本共享。

新域名无法读取 `localhost` 域名下的浏览器存储。若需要迁移本机现有数据，请先备份 `data/offerflow.db`；部署后可通过状态 API 导入，或把数据库文件上传到持久卷。不要先在新域名修改示例数据，以免与待迁移数据混淆。

也可以在任意支持 Docker 和持久卷的平台运行：

```bash
docker build -t offerflow .
docker run --rm -p 8080:8080 \
  -e OFFERFLOW_PASSWORD='替换为强密码' \
  -v offerflow-data:/data \
  offerflow
```

打开 [http://localhost:8080](http://localhost:8080)，用户名为 `offerflow`。

## 数据存储

默认数据库位于 `data/offerflow.db`，已通过 `.gitignore` 排除，不会被提交到 GitHub。

首次连接空数据库时，应用会把同一浏览器地址下已有的 `localStorage` 数据迁移到 SQLite。数据库建立后以 SQLite 为准，浏览器存储仅作为后端不可用时的本地兜底。页面重新获得焦点时会检查其他设备的修改，并通过版本号阻止旧页面覆盖较新的数据。

备份时可以复制数据库文件，或使用界面中的“导出 CSV”。复制数据库前建议先停止服务。

## 项目结构

```text
.
├── index.html          # 页面结构
├── styles.css          # 视觉与响应式布局
├── app.js              # 前端状态、交互与同步逻辑
├── server.py           # 静态服务与 SQLite JSON API
└── tests/
    └── test_server.py  # 数据库读写测试
```

后端提供三个同源接口：

- `GET /api/health`：服务健康检查
- `GET /api/state`：读取完整应用状态
- `PUT /api/state`：原子写入完整应用状态

## 测试

```bash
python3 -m unittest discover -s tests
node --check app.js
```

## 隐私

本地模式仅监听 `127.0.0.1`；监听公网地址时必须通过 `OFFERFLOW_PASSWORD` 启用 HTTP Basic Auth。生产环境必须使用平台提供的 HTTPS 域名，因为 Basic Auth 本身不加密传输。服务器仅公开三个前端文件，数据库、后端源码和 Git 元数据不会由静态服务器提供。请勿把 `data/offerflow.db`、导出的 CSV 或包含真实会议链接的文件提交到公开仓库。
