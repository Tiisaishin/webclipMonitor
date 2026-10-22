# 在 SnapDeploy 上部署 WebClip Monitor（Docker）

本教程在 [SnapDeploy](https://snapdeploy.dev) 上部署 WebClip Monitor：一个
**Docker Web 服务** + 一个**托管 PostgreSQL**。项目自带 `Dockerfile`（Chromium 已
内置），直接从 GitHub 部署即可。

> ⚠️ **先读这条**：本应用用 Playwright/Chromium 跑真实浏览器，**内存需求较高**。
> SnapDeploy 免费层容器是 **512 MB**，Chromium 在这个内存下很可能 OOM（内存不足崩溃）。
> 跑真实扫描建议选**内存更大的付费容器**；免费层适合先把界面/流程跑起来看看。
>
> 另外：我没能直接打开 SnapDeploy 控制台核对每个按钮的精确名称，下面的步骤基于其
> 官方文档与示例整理，**具体界面以 SnapDeploy 控制台实际为准**；关键约定（PORT 自动
> 注入、Dockerfile 部署、add-on 注入数据库变量）是明确的。

---

## 0. 前置条件

- 代码在 GitHub 仓库里（`main` 分支已含 `Dockerfile`）。
- 一个 SnapDeploy 账号（<https://snapdeploy.dev>）。
- 免费层额度（撰写时）：**4 个容器、每个 512 MB、100 小时/月、每天 10 次部署**，
  容器**闲置 15 分钟后休眠**。

> 本应用监听 SnapDeploy 注入的 `PORT`、绑定 `0.0.0.0`、启动时自动迁移数据库，
> 完全符合平台要求。

---

## 1. 创建托管 PostgreSQL

1. 在 SnapDeploy 控制台新建一个 **PostgreSQL** 数据库（add-on）。
2. 创建后，复制它的**连接字符串**（形如
   `postgres://user:pass@host:5432/dbname`）——下一步作为 `DATABASE_URL`。

> SnapDeploy 的数据库 add-on 在部署时**链接到容器**后，会自动注入连接变量
> （包含 `DATABASE_URL` 及 host/port）。如果你用的是「链接 add-on」方式，`DATABASE_URL`
> 可能已自动可用；若没有，就按下一步手动填。

---

## 2. 部署 Web 服务（从 GitHub + Docker）

1. 控制台选择 **Deploy from GitHub**，选择本仓库与 `main` 分支。
2. **Dockerfile 路径**：`Dockerfile`（仓库根目录，SnapDeploy 会用它构建；不要用自动
   生成的 Dockerfile，本项目自带的已把 Chromium 装好）。
3. **环境变量**（在**首次构建之前**设好）：

   | Key | Value | 说明 |
   |-----|-------|------|
   | `DATABASE_URL` | 第 1 步的 Postgres 连接串（若 add-on 已自动注入可省略） | 必填 |
   | `CRAWL_CONCURRENCY` | `1` | 省内存，512 MB 下务必调低 |

   - **不要设置 `PORT`**：`PORT` 由平台保留并自动注入，应用会读取它并监听
     `0.0.0.0`。
   - **Telegram 不在这里配**：bot token / chat id 部署后在**后台「设置」页**填写，
     不走环境变量。
   - 如果连接数据库报 SSL 相关错误（外网连接常见），加 `DATABASE_SSL=true`；
     连接串里带 `sslmode=require` 时本应用也会自动开启 SSL。
   - 密钥只放在 SnapDeploy 的环境变量里，**不要**提交进仓库或写进镜像。
4. 部署。构建完成后会分配一个 HTTPS 地址。
   - 首次构建会拉取 Playwright 基础镜像（约 2 GB）并 `npm ci`，耗时几分钟，属正常。

> 之后每次 push 到关联分支都会自动触发重新部署。

---

## 3. 验证

1. 看部署日志，出现以下内容即正常：
   ```
   [migrate] schema applied
   [http] listening on http://0.0.0.0:<PORT>
   ```
2. 打开分配的 HTTPS 地址，看到中文后台。
3. 进 **设置** 页填 Telegram Bot Token / Chat ID，**保存**后点**发送测试消息**确认。
4. 回**扫描任务**页建个任务试跑（免费层内存紧张时建议 `max_depth` 小一点、
   `CRAWL_CONCURRENCY=1`）。

---

## 4. 免费层注意事项 ⚠️

1. **内存 512 MB**：Chromium 很吃内存，免费层**可能 OOM**。现象：扫描时容器重启/
   任务报错。对策：`CRAWL_CONCURRENCY=1`、降低深度，或**升级到更大内存的容器**。
2. **闲置 15 分钟休眠**：休眠时进程内的 cron **定时重扫不会触发**。手动/按需扫描
   不受影响。想定时可靠：用外部定时服务（如 cron-job.org）每 10 分钟 GET 一次
   `https://<你的域名>/api/health` 保活，或用常驻（Always-On）付费容器。
3. **每天 10 次部署上限**：频繁 push 会触发重部署，注意次数。
4. **数据库损坏自愈**：若早期部署在库里留下半截损坏的表、启动迁移报
   `column ... does not exist`，临时加环境变量 `DB_RESET=true` 部署一次（会**清空
   数据库**重建），日志出现 `schema applied (after reset)` 后**立刻删掉该变量**再部署。

---

## 5. 常见问题

| 现象 | 处理 |
|------|------|
| 扫描时容器重启 / 任务失败 | 多半是 512 MB 内存不够，`CRAWL_CONCURRENCY=1` + 降深度，或升级内存 |
| 启动连不上数据库 | 确认 `DATABASE_URL` 正确；外网连接报 SSL 错则加 `DATABASE_SSL=true` |
| 端口相关报错 / 探测不到端口 | 不要手动设 `PORT`，交给平台注入；应用已监听 `0.0.0.0` |
| 迁移报 `column ... does not exist` | 用 `DB_RESET=true` 一次性重置（见上，用完即删） |
| 首次构建慢 | Playwright 基础镜像约 2 GB，首次拉取慢，正常 |

---

对比：如果更看重 Playwright/Chromium 的内存与稳定性，也可参考
[`docs/deploy-render.md`](deploy-render.md)（Render 免费层同样 512 MB、同样会休眠，
注意事项类似）。核心都是：**Docker 运行时 + 托管 Postgres 分开建、用平台注入的
`PORT`、Telegram 在后台配、内存紧张就降并发或升配**。

---

来源（整理自以下公开资料，具体以 SnapDeploy 官方为准）：
- [SnapDeploy Docker Hosting](https://snapdeploy.dev/docker-hosting)
- [SnapDeploy Getting Started](https://snapdeploy.dev/docs/getting-started)
- [SnapDeploy Docs](https://snapdeploy.dev/docs)
- [示例仓库 wasp-on-snapdeploy](https://github.com/AAR-Labs/wasp-on-snapdeploy)
- [Leaving Render's Free Tier → Docker Host](https://snapdeploy.dev/blog/render-free-tier-migration-docker-host)
