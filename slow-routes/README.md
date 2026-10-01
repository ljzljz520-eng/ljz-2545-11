# 慢行站 · 路线投稿全栈编辑流程

网页提交**折线（GeoJSON LineString）+ 故事 + 歇脚点**，Node(Express) API 在服务端校验几何并管理审核，
PostgreSQL 保存**草稿分支、不可变发布版、审核理由与依据**。

- 后端：Node.js 20 + Express 5 + `pg`
- 数据库：PostgreSQL（开发/测试用 [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres) 自动起一个真实 PG18，无需系统安装；生产用 `DATABASE_URL` 接外部 PG）
- 前端：原生 HTML/CSS/JS + Canvas 轻量地图（无外部 CDN 依赖，离线可用）

## 运行

```bash
npm install
npm start          # 首次自动下载并初始化内嵌 PG、建表、种子用户，监听 :3000
# 或用外部 Postgres：
DATABASE_URL=postgres://user:pass@host:5432/slowroutes npm run migrate && DATABASE_URL=... npm start
```

打开 http://localhost:3000 ，右上角切换身份（同一浏览器即四个角色的演示令牌）：

| 角色 | 令牌 | 能做 |
|---|---|---|
| 小林（作者） | `token-author` | 建线/画折线/写故事/歇脚点/传照片/投稿/撤回 |
| 阿周（作者） | `token-author2` | 第二个作者（不能读他人草稿） |
| 老陈（审核员） | `token-reviewer` | 看待审快照、通过/要求修改/驳回 |
| 站长（管理员） | `token-admin` | 审核 + 精选卡 |

测试（每个场景独立数据库）：

```bash
npm test           # 7 个验收场景，共 100 条断言
```

## 需求 → 设计/验收对照

### 1. 服务端强制 GeoJSON 校验（不能靠客户端检查）
`src/services/geo.js` 在**每个**写入入口（整线保存/分段插入/移动/删除/投稿）都重新校验：
- 必须是 LineString；顶点 2–500 个（**复杂度上限**）；无重复顶点。
- 坐标**有界**（经度 73–135.1、纬度 18–53.6）、最多 7 位小数、必须是有限数。
- 单段长度 0.5m–50km、总长 ≤500km（防止穿越式/脏折线）。
- **折线自交检测**（非相邻段真相交、相邻段回头重叠均拒绝）。
- 标题/故事/歇脚点/理由长度限制；照片类型(jpeg/png/webp)与 5MB 上限。
- 验收：`t1_validation.js`。

### 2. PG 保存草稿分支、发布版和理由
- `routes`：当前工作副本（草稿分支）+ 状态机
  `draft → in_review → (changes_requested → in_review)* → published → withdrawn`。
- `route_revisions`：每次投稿/要求修改/撤回都冻结**不可变版本**（几何、故事、歇脚点快照、理由、双指纹）。
- `publications`：后台发布落地的**不可变发布快照**，带 `approved_review_id`。
- 每个动作写 `audit_log`。

### 3. 审核必须针对“确定的路线几何及文字版”；作者审核中改危险路口不能沿用旧同意
- 审核行 `reviews` 绑定**几何指纹 + 文字指纹**（两个独立维度，`bound_geom_fingerprint/bound_text_fingerprint`），
  并引用送审时冻结的 revision；审核员页面读的是**快照**而非可被偷换的工作副本。
- 审核中作者一旦改几何（如移动危险路口顶点）或改文字：
  进行中的 pending 审核立刻 `superseded`，路线回到 `changes_requested`，`active_review_id` 置空。
- 审核员对旧单点“通过”时，服务端在事务内再次比对指纹，不一致 → **409**，必须让作者用新版本重新投稿。
- 验收：`t3_review.js`（14 条，含改几何、改文字、复审通过、待审列表过滤）。

### 4. 精选卡引用发布快照；撤回后旧链接保留状态说明但不泄漏未公开草稿
- `featured_cards.publication_id` 外键指向 `publications`（**绝不指向草稿/路线工作副本**）。
- 精选创建时强制：发布版未撤回 + 其审核是未失效的 approved（**任何被精选版本都有完整审核依据**）。
- 作者撤回：`publications` 行**保留**（`withdrawn_at/withdrawn_note`），旧链接 200 返回旧快照+状态说明；
  草稿的新标题/新故事/新几何不会出现在任何公开响应里；匿名/他人访问草稿 401/404；搜索索引移除。
- 精选卡撤回后仍展示旧快照但打“已撤回”标。
- 验收：`t5_published_featured.js`（24 条）、`t7_audit_basis.js`。

### 5. 几何修改与点位备注的依赖：整路线乐观锁 vs 分段合并；插删后提示点重新定位
同时提供两种并发策略，不是二选一：

- **整路线乐观锁**：`routes.route_version` 单调递增；`PUT /api/routes/:id` 带 `expected_version`，
  过期 → 409（`your_version/current_version`），前端提示“拉取最新并合并”。
- **分段合并（细粒度乐观锁）**：折线被切成路段 `route_segments`（稳定 `uid` + 每段 `seg_version`）。
  - 插入顶点：段分裂，**前半段保留旧 uid 并 bump 版本，后半段分配新 uid**（锚在前半段的歇脚点无需迁移）；
  - 删除顶点：相邻两段合并，保留前一段 uid + bump，被删段 uid 消失；
  - 移动顶点：只触碰相邻两段，编辑者带上这两段版本号即可；
  - **改不同段的并发编辑可以合并成功；同时改同一段且版本过期 → 409**，冲突明细给出具体 uid。

歇脚点锚定模型（`route_stops.anchor = {kind:'segment', uid, t}`，t 为段内参数位置）：
- 任何几何变更后，服务端用 `evaluateStopsAfterGeometry` 重投影所有点：
  段消失/漂移超过 25m → 自动标记 `needs_relocation`（并吸附到最近新段作为**建议位置**），
  提交审核前必须由作者逐个 `/relocate` 确认，否则 409。
- 点位备注与几何共存在同一资源上，备注修改不动指纹（不牵连几何审核）。
- 验收：`t2_concurrency.js`（15 条，含两人改不同段成功、改同段冲突、删点强制重定位、插入保留 uid）。

### 6. 离线重送
- 所有改变状态的端点接受 `Idempotency-Key`：键 + 请求体哈希唯一，重放返回首次状态/响应并带 `Idempotent-Replay: true`；
  同键不同体 → 422。
- 前端检测 `offline/online`：离线时把请求放进 localStorage 队列，恢复在线后串行重放（投稿/撤回天然去重）。
- 验收：`t4_offline_photos.js`。

### 7. 照片未上传完不能提交
- 两步：先 `POST /api/photos` 直传二进制（服务端校验类型/大小，落盘 + `photos.status='ready'`），
  再在投稿时只允许引用**存在、属于本人、ready** 的照片 id；任何缺失/未完成 → 拒绝投稿。
- 验收：`t4_offline_photos.js`。

### 8. 后台发布与搜索索引更新可重试
- 审核通过只入队 `jobs(type='publish')`，worker 认领（`FOR UPDATE SKIP LOCKED` + 租约），
  事务内落地不可变 `publications` 并刷新 `search_index`（GIN 全文索引）。
- 失败指数退避重试（attempts 与租约在执行前独立持久化，崩溃后可重新认领），超过次数 → `dead` 并保留 `last_error`，
  不阻塞其他任务；发布执行幂等（消息重复投递不产生重复发布）。
- 撤回入队 `unindex`；**审核依据不完整/已失效时发布任务拒绝落地**，重试耗尽进 dead。
- 验收：`t6_jobs_retry.js`（含故障注入、退避、dead-letter、重复投递、无依据拒绝）。

### 9. 审核与撤回竞争
数据库行锁（`SELECT ... FOR UPDATE`）+ 状态机判定：
- 审核中撤回 → 撤回优先：pending 审核作废，路线回 draft；迟到的 approve → 409。
- approve 先提交 → 路线变 published，随后的撤回走“已发布撤回”分支（旧链接保留）。
- 验收：`t3_review.js` 两个方向各一条。

## 目录

```
src/
  config.js               # 所有限制/边界/复杂度阈值（服务端唯一真相）
  server.js               # Express 路由装配
  db/schema.sql           # 表结构（含注释）
  db/migrate.js embedded.js pool.js
  services/
    geo.js                # 几何校验/自交/指纹/锚点重定位/错误类型
    routes.js segments.js stops.js submissions.js
    reviews.js photos.js publishing.js featured.js public.js
    jobs.js worker.js idempotency.js auth.js store.js
public/                   # 前端（index.html / style.css / api.js / app.js）
uploads/                  # 照片落盘目录
test/t1..t7_*.js + helpers.js + run-all.js
```

## 备注 / 取舍

- 几何以 GeoJSON JSONB 存储并用 Node 做拓扑计算，便于阅读与跨环境运行；
  生产可把 `working_geom/geometry` 换成 PostGIS `geometry(LineString,4326)`，服务端语义与测试不变。
- 演示用固定 Bearer 令牌（种子用户）；生产应替换为正式鉴权，照片直传建议改为预签名 URL。
