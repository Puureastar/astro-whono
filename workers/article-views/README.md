# 单篇文章阅读次数

Astro 继续输出静态 `dist`，Cloudflare Pages 保持现有构建方式。本目录是独立 Worker 和 D1 计数服务；只接管正式域名的 `/api/views/*`。不需要写作服务器运行数据库或统计进程。

## 统计口径

- 文章详情页显示“阅读 N 次”，不是独立人数，也不证明读完正文。历史次数无法补算，从启用时开始。
- 正式域名的 canonical 详情页可见5秒才写入；同一浏览器同篇文章30分钟复用随机事件。刷新不重复增加。隐藏标签页暂停计时；BFCache 恢复开启新的5秒计时。
- 草稿、写作站、默认 pages.dev、列表页不计数。构建失败、接口失败或被关闭时隐藏数字，正文照常可读。
- localStorage 不可用时只在当前页保留事件；同时打开多个标签页有初始竞争，可能多计。跨设备不合并，不宣称 UV 或绝对防刷。
- D1 只保存总数、随机事件摘要和 UTC 日预算；不存 IP、User-Agent、文章正文。IP 摘要仅作边缘短期限流键，不能称为不可逆匿名化。
- 事件收据48小时过期，每天清理一次，正常物理保留约48–72小时；清理失败可能更久。清理不会减少文章总数。
- 边缘约60请求/分钟、20写入/分钟/IP；这是各边缘位置近似限速。每日最多5000个新事件是应用预算，不能保证恶意请求不消耗 Cloudflare 请求/读取配额，也不是计费硬上限。不自动升级付费计划。

## 文章 ID

后台新建文章自动生成 UUIDv4 `viewId`，编辑标题、正文、slug 不改变它。手写或导入的 Markdown 可显式补 ID：

```bash
# 在博客仓库根目录；先看预览，确认再写入。构建本身不改文章。
node scripts/assign-view-ids.mjs
node scripts/assign-view-ids.mjs --write
git diff -- src/content/essay
```

工具跳过草稿，不改变正文或草稿状态。没有 ID 的文章仍能显示；重复 ID 会使公开清单构建报错。复制文章时应删除旧 ID，再生成新的。不要删除旧文章 ID 后重建，否则将得到新计数。

## 验证

根项目使用 Node **22.22.0** 和已有锁文件 `npm ci`。本目录的发布工具独立固定 Wrangler **4.151.3**，安装使用本目录锁文件，不修改根依赖。

```bash
# 根目录，隔离 checkout 执行，避免与写作服务争用生成目录
npm ci
npm test -- tests/article-views-client.test.ts tests/article-views-worker.test.ts tests/article-views-manifest.test.ts tests/admin-content-create.test.ts tests/admin-content-write-essay.test.ts
SITE_URL=https://blog.pureastar.top npm run check
SITE_URL=https://blog.pureastar.top npm run build

cd workers/article-views
npm ci
WRANGLER_SEND_METRICS=false npm run test:runtime
```

`test:runtime` 仅使用本机 workerd/D1，验证 SQL 迁移、并发、预算、回滚、清理和限流绑定。无需 Cloudflare 登录，不创建远程数据库。其测试打包工具来自锁定的 Wrangler 依赖树。

## 发布前置条件与顺序

此代码不能单凭成功构建视作已上线。首次需要明确批准独立 Worker、D1、专用路由及本功能提交推送。不要将后续个人编辑或私人草稿捎带发布；不修改上游修复 PR 分支。

1. 核对账号计划和已有 Worker 路由、限流 namespace。保存相关配置快照；路由冲突时停止，不能覆盖其他服务。给两个限流绑定选取未被该账号使用的不同数字 ID。
2. 在操作员电脑或服务器 root-only 目录建立审核后的发布包；管理 token/OAuth 不能放在 blog 用户、code-server 或仓库可读的目录。先安装锁定工具，再加载管理凭据。运行时仅使用资源绑定，不使用管理密钥。
3. 复制 `wrangler.example.jsonc` 到仓库之外的部署目录；填写实际账号、数据库 ID、绝对入口和迁移路径。初始保持 `VIEWS_ENABLED:"false"`、`routes:[]`、`workers_dev:false`、`preview_urls:false`。不要以模板占位 ID 直接发布。
4. 用审核配置创建专用 D1，执行 `wrangler d1 migrations apply astro-whono-article-views --remote --config <绝对配置路径>`。受控验证真实数据库的绑定和原子计数，再导出备份。
5. 经确认推送本功能提交至 `blog`，等待 Pages 构建成功，核实默认 Pages 地址的 `/article-views-manifest.json` 只含已发布 ID。
6. 仅添加 `{"pattern":"blog.pureastar.top/api/views/*","zone_name":"pureastar.top"}` 路由，再将开关设为字符串 `"true"` 部署 Worker。不要设置整域通配路由。
7. 真实验收详情页延时、刷新去重、列表/写作站不计数、未知 ID 和跨源写入拒绝。使用现有公开文章会产生少量测试次数，应记录；不上传私人草稿做验收。

## 关闭、备份与恢复

- 快速关闭：将实际配置的 `VIEWS_ENABLED` 改为 `"false"` 并重新部署。API 返回503、前端隐藏，数据库保留。
- 路由回滚：将此 Worker 的实际配置 `routes` 恢复为 `[]` 并部署，仅移除本功能专用路由。Pages 的 HTML/404 回退不会被显示成假0。
- 代码回滚使用本功能提交的 `git revert`，不强制 reset、不覆盖未提交写作内容。
- 操作员 root-only 备份目录中执行 `wrangler d1 export astro-whono-article-views --remote --output <备份.sql> --config <绝对配置路径>`，尤其在后续迁移前导出。不要将收据备份上传公开仓库。
- 恢复先导入新建的隔离 D1，核对 totals 与 receipt/budget 一致性，再切换数据库绑定，旧库保留。不要直接向有数据的线上库重复导入，也不要把收据清空当作常规恢复。
- 计数数据不在 Git 文章仓库内；GitHub 与服务器文章备份不能代替 D1 导出。

当前代码是否已部署、实际数据库 ID、路由和验收结果以运维交付记录为准。
