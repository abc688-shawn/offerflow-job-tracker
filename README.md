# OfferFlow

OfferFlow 是一个支持多用户数据隔离的求职进度管理工具。线上服务用于公网访问，本地服务用于开发和局域网预览，两者使用独立的 SQLite 数据库。

## 首次准备

本机需要 Node.js 20+、npm 和 Python 3.9+。首次使用时安装依赖：

```bash
cd /Users/shawn/offerflow-job-tracker
npm ci
```

## 开启本地服务

```bash
cd /Users/shawn/offerflow-job-tracker
npm run dev:lan
```

启动后，终端会打印访问地址：

- `http://127.0.0.1:4173`：本机访问
- `http://局域网IP:4173`：同一局域网内的其他设备访问

本地数据保存在 `data/offerflow.db`，不会影响线上数据。修改代码后，需要停止并重新运行服务才能看到新版本。

如果 `4173` 端口已被占用，可改用其他端口：

```bash
OFFERFLOW_LOCAL_PORT=4180 npm run dev:lan
```

## 关闭本地服务

在运行服务的终端中按 `Control + C`。

如果原终端已经关闭，可执行下面的命令停止占用 `4173` 端口的服务：

```bash
lsof -tiTCP:4173 -sTCP:LISTEN | while read -r pid; do kill "$pid"; done
```

如果启动时使用了其他端口，请把命令中的 `4173` 换成实际端口。

## 把本地修改上线

部署前需要确保 SSH 私钥位于 `~/.ssh/offerflow_deploy_ed25519`。

先提交并推送代码，让本地、GitHub 和服务器版本保持可追踪：

```bash
cd /Users/shawn/offerflow-job-tracker
git status
git add -A
git status
git commit -m "Update OfferFlow"
git push origin main
```

确认 `git status` 中没有误加入密码、密钥或本地数据库，再执行部署：

```bash
npm run deploy:server
```

该命令会自动构建和测试、备份服务器当前版本、上传代码、重启服务并进行健康检查；失败时会自动回滚。部署不会覆盖线上数据库、用户配置、环境变量、备份或 HTTPS 证书。

部署成功后访问：

```text
https://139.196.218.231
```

注意：`npm run deploy:server` 部署当前工作区内容，但不会自动执行 `git commit` 或 `git push`，因此应先完成上面的 Git 操作。

## 检查本地与服务器是否一致

```bash
cd /Users/shawn/offerflow-job-tracker
npm run check:server
```

看到下面的信息表示应用代码一致：

```text
Local and server deployment files are in sync.
```

该命令只比较部署文件，不比较本地和线上的业务数据。

## 服务器故障排查

登录服务器：

```bash
ssh -i ~/.ssh/offerflow_deploy_ed25519 admin@139.196.218.231
```

查看服务状态和最近日志：

```bash
sudo systemctl status offerflow nginx
sudo journalctl -u offerflow -n 100 --no-pager
```

线上应用及相关文件统一位于 `/opt/offerflow`。
