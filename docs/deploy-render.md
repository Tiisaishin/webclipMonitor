# 在 Render 上部署 WebClip Monitor（免费 · Docker · 不用 Blueprint）

本教程手把手在 [Render](https://render.com) 上部署 WebClip Monitor：
**PostgreSQL 数据库** 和 **Web 服务** 两个资源**分开创建**，Web 服务用项目自带的
`Dockerfile`（Chromium 已内置），全程使用免费套餐，不使用 `render.yaml`（Blueprint）。

---

## 0. 前置条件

- 一个 **GitHub 账号**，代码已在仓库里（例如 `Tiisaishin/webclipMonitor`，`main`
  分支已包含 `Dockerfile`）。
- 一个 **Render 账号**：到 <https://render.com> 用 GitHub 登录注册即可。
- 不需要本地装任何东西，全部在 Render 网页上操作。

> 架构：一个常驻的 Node 容器，内含 HTTP 后台 + 扫描 worker + 定时器，
> 启动时自动迁移数据库表结构。它监听 Render 注入的 `$PORT`。

---

## 1. 创建 PostgreSQL 数据库

1. 进入 Render 控制台，点右上角 **New +** → **PostgreSQL**。
2. 填写：
   - **Name**：`webclip-db`（随意）
   - **Database** / **User**：留默认即可
   - **Region**：选离你近的区域，**记住它**（Web 服务要选同一区域）
   - **Plan**：选 **Free**
3. 点 **Create Database**，等待状态变成 **Available**（约 1 分钟）。
4. 打开数据库详情页，找到 **Connections** 区块，复制 **Internal Database URL**
   （形如 `postgres://user:pass@dpg-xxxxx/webclip_monitor`）。
   - **Internal URL**：同区域的 Web 服务走内网访问，**不需要 SSL**，首选。
   - External URL：从 Render 外部访问才用，走公网，需要 SSL（见下文 `DATABASE_SSL`）。

---

## 2. 创建 Web 服务（Docker 运行时）

1. 点 **New +** → **Web Service**。
2. 选择 **Build and deploy from a Git repository**，连接并选择你的仓库
   `Tiisaishin/webclipMonitor`（首次需要授权 Render 访问你的 GitHub 仓库）。
3. 配置：
   - **Name**：`webclip-monitor`
   - **Region**：**务必和数据库选同一个区域**（否则内网地址连不上）
   - **Branch**：`main`
   - **Runtime / Language**：Render 检测到 `Dockerfile` 后会自动选 **Docker**。
     - **Root Directory**：留空
     - **Build Command** / **Start Command**：**留空**（用 `Dockerfile` 里的 `CMD`）
   - **Instance Type**：选 **Free**
4. 展开 **Advanced**，添加 **Environment Variables**：

   | Key | Value | 说明 |
   |-----|-------|------|
   | `DATABASE_URL` | 第 1 步复制的 **Internal Database URL** | 必填 |
   | `CRAWL_CONCURRENCY` | `2` | 免费只有 512MB 内存，Chromium 吃内存，建议 1–2 |
   | `TELEGRAM_BOT_TOKEN` | 你的 bot token | 可选，也可之后在后台「设置」里填 |
   | `TELEGRAM_CHAT_ID` | 你的 chat id | 可选，同上 |

   - **不要设置 `PORT`**：Render 会自动注入，应用会读取它。
   - 只有当你改用 **External** 数据库地址时，才额外加 `DATABASE_SSL=true`；用
     Internal 地址不用加。
5. 仍在 **Advanced** 里，设置 **Health Check Path**：`/api/health`。
6. 点 **Create Web Service**。

> 首次构建会拉取 Playwright 官方镜像（约 2GB）并执行 `npm ci`，耗时几分钟，属正常现象。

---

## 3. 验证部署

1. 在 Web 服务的 **Logs** 里，应能看到类似输出：
   ```
   [migrate] schema applied
   [http] listening on http://0.0.0.0:10000
   ```
   （`[migrate] schema applied` 说明数据库表已自动建好。）
2. 打开 Render 分配的地址（形如 `https://webclip-monitor.onrender.com`），
   能看到中文后台界面。
3. 进 **设置** 页填写 Telegram（或确认环境变量已生效），点 **发送测试消息**，
   确认 Telegram 能收到。
4. 回 **扫描任务** 页，新建一个任务试跑。

---

## 4. 日常使用与更新

- **更新代码**：向 `main` 推送提交，Render 默认开启 **Auto-Deploy**，会自动重新
  构建并部署。
- **数据库迁移**：应用每次启动自动执行，无需手动操作。表结构变更用的是幂等
  `ALTER ... IF NOT EXISTS`，重复启动安全。

---

## 5. 免费套餐的注意事项 ⚠️

1. **休眠导致定时重扫不触发**
   免费 Web 服务闲置约 **15 分钟后会休眠**，休眠期间进程内的 cron 定时器不会运行，
   所以**定时重扫（任务里的 Cron）在休眠时不会触发**。
   - 手动点「运行」、以及服务醒着时的扫描都正常。
   - 想让定时更可靠，二选一：
     - **保活**：用免费的外部定时服务（如 [cron-job.org](https://cron-job.org)、
       UptimeRobot）每 10 分钟 GET 一次
       `https://<你的域名>.onrender.com/api/health`，让服务不休眠；
     - 或升级到**付费实例**（常驻不休眠）。
2. **免费数据库有有效期**
   Render 的免费 PostgreSQL 到期后（按 Render 当时的政策，通常一段时间后过期）
   会被删除，**重要数据请定期备份**；过期后需新建数据库并更新 `DATABASE_URL`。
3. **内存 512MB**
   Chromium 比较吃内存，`CRAWL_CONCURRENCY` 建议 **1–2**，深度不要设太大。

---

## 6. 常见问题

| 现象 | 原因 / 解决 |
|------|-------------|
| 首次构建很慢或超时 | Playwright 基础镜像约 2GB，首次拉取慢，属正常；重试即可 |
| 启动报连不上数据库 | 确认 Web 与 DB **同一区域**、用的是 **Internal URL**；跨区或用 External 则加 `DATABASE_SSL=true` |
| 页面能开但扫描报内存错 / Chromium 崩溃 | 降低 `CRAWL_CONCURRENCY`（设 1），或升级实例规格 |
| 定时任务到点不跑 | 免费实例休眠所致，见第 5 节「保活」 |
| 域名过期查询一直是「未知」 | RDAP/WHOIS 需要出站网络（Render 默认允许）；个别 TLD 的 RDAP 可能不可用，会回退 WHOIS |
| 打开后端口相关报错 | 不要手动设置 `PORT`，交给 Render 注入 |

---

## 7. 保活定时任务示例（可选）

用 [cron-job.org](https://cron-job.org) 创建一个任务：

- **URL**：`https://<你的域名>.onrender.com/api/health`
- **Schedule**：每 10 分钟一次（`*/10 * * * *`）

这样服务基本不会休眠，后台里配置的「定时重扫 Cron」也就能按时触发了。

---

部署完成后，所有配置（Telegram、告警阈值、每域名解码规则等）都能在后台 **设置**
页随时修改，无需重新部署。
