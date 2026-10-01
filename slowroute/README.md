# 慢行站 · 路线投稿全栈编辑流程

网页提交**折线、故事与歇脚点**；Node API 服务端校验 GeoJSON 并管理审核；
PostgreSQL 保存**草稿分支、发布版和理由**；后台任务驱动发布与搜索索引更新（可重试）。

零第三方运行时依赖即可启动与测试（内存仓储）；设置 `DATABASE_URL` 后切换到 PostgreSQL
（同一套领域服务与仓储接口，见“双仓储”一节）。

## 运行

```bash
npm install            # 仅需 Node 18+；运行时零依赖
npm test               # 38 个测试：几何/合并单测 + 验收 + HTTP + 仓储契约
npm start              # http://localhost:3000  （内存仓储，含内嵌后台 worker）
```

用 Postgres：

```bash
docker compose -f docker-compose.pg.yml up -d postgres
DATABASE_URL=postgres://postgres:slowroute@localhost:5433/slowroute npm start
# 独立 worker（也可以多副本）：
DATABASE_URL=... node src/worker.js
```

打开网页后右上角可切换 **作者-小林 / 审核员-老周** 两个演示身份。

## 需求 → 实现对照

| 需求 | 实现 |
| --- | --- |
| 网页提交折线、故事、歇脚点 | `src/static/index.html` + `app.js`：SVG 画布拖顶点/点边插点/删点/落歇脚点，故事与点位备注表单 |
| Node API 校验 GeoJSON | `src/geometry.js` / `src/validation.js`：LineString 结构、坐标有界、顶点上限 500、退化边、总长、**自交检测**；错误都返回机器码 |
| 坐标有界且限制复杂度，不能靠客户端 | 边界在 `config.LIMITS`，`parseLineString` 在**服务端**强制；前端“服务端校验”按钮只是演示，真正闸门在 POST/PUT/PATCH |
| PG 保存草稿分支、发布版、理由 | `src/schema.sql`：`route_versions` 以 `parent_version_id` 串起草稿分支；`reviews` 存动作、理由、指纹与完整快照 |
| 审核针对确定路线几何及文字版 | `versionFingerprint()` 对几何+vertexIds+标题+故事+歇脚点锚点做规范化哈希；审核请求必须带 `expectedFingerprint` |
| 作者审核中改危险路口不能沿用旧同意 | 审核中 PUT 整包 → 旧版本 `withdrawn` 留痕并 `supersededById` 指向新草稿分支；旧指纹的裁决返回 `not_in_review`，必须重新送审 |
| 精选卡引用发布快照，撤回后旧链接保留状态说明但不泄漏草稿 | 精选卡存 `snapshot` 与 `reviewBasis`；撤回后卡片失活并写 `deactivated_reason`；旧版本链接返回 **410 + 状态说明**，不含几何/故事/后继草稿 id；匿名访问未公开路线为 404 |
| 几何修改与点位备注依赖 | 歇脚点存锚点 `{edgeKey(from>to), t, dxM, dyM}`；路段插删后 `relinkRestPoints` 给出 attached / repositioned / detached |
| 比较整路线乐观锁 vs 分段合并 | 整包 PUT 带 `x-expected-geometry-rev`（`geometry_rev_stale`）；分段 PATCH 带 `baseGeometryRev + baseTags(edgeEtags)`，同边改动 → `same_segment_conflict`，不同路段自动合并 |
| 路段插删后提示点重新定位的冲突处理 | 服务端返回 `point_needs_relocate` 与 detached/repositioned 明细；作者用同一 `clientOpId` 带 `resolutions`（重落点/删除）重发，前端弹窗引导 |
| 同时编辑同一路段 | `same_segment_conflict`，后到方 rebase；不同路段操作互不阻塞（`merge.js` 单测覆盖） |
| 离线重送 | 分段操作带 `clientOpId`，`processed_batches` 去重，同键返回首次结果；整包 POST 支持 `Idempotency-Key` |
| 审核与撤回竞争 | 版本行事务：内存库 per-key 锁；PG 为 `SELECT … FOR UPDATE` + advisory lock。先裁决则撤回失败，先撤回则裁决 `not_in_review` |
| 折线自交 | `findSelfIntersection` 检测非相邻边真相交与端点触碰（蝴蝶结），返回交点与边序号 |
| 照片未上传完 | 两段式 `/api/photos` → `uploading`/`ready`；提交时 `assertPhotosReady`，缺一张即 `photos_not_ready` |
| 后台发布与搜索索引更新可重试 | `outbox` 与版本同事务写入；`worker.js` 单轮 claim → 执行 → done/指数退避重试/超过 5 次 dead；`POST /api/admin/pump` 可手工驱动 |
| 任何被精选版本都有完整审核依据 | `feature` 校验版本为 published、存在 approve 的 review 且其 fingerprint 与当前版本一致，否则 `missing_review_basis`；卡片持久化审核员、理由、指纹、时间 |

## 版本状态机

```
draft ──submit──▶ in_review ──approve──▶ approved ──publish──▶ published
  ▲                  │                     │                       │
  │                  ├──reject──▶ rejected │                       └─withdraw─▶ withdrawn
  └─改稿产生新分支──  └─withdraw──▶ withdrawn └（撤回发布同样落 withdrawn）
```

审核中作者改稿：旧 in_review 版本直接转 withdrawn（保留理由与状态说明），修改进入**新草稿分支**，
需要重新 submit、重新 review——旧审核同意绝不沿用。

## HTTP API 摘要

```
POST   /api/photos                     登记上传（uploading）
POST   /api/photos/:id/complete        上传完成（ready）
POST   /api/routes                     整包创建草稿            [Idempotency-Key]
GET    /api/routes                     我的路线 / 审核员看待审
GET    /api/routes/:id                 公开版 + （作者/审核员）草稿与版本树
PUT    /api/routes/:id                 整包替换                x-expected-geometry-rev
PATCH  /api/routes/:id/segment-batch   分段插删/移动+点位解决  body.clientOpId 幂等
PATCH  /api/routes/:id/story           故事/标题               expectedStoryRev
PUT    /api/versions/:id/points/:pid/note                      x-expected-note-rev
POST   /api/routes/:id/submit          送审（照片闸门）
POST   /api/versions/:id/review        通过/驳回（expectedFingerprint + reason）
POST   /api/routes/:id/publish         发布（同事务写 outbox）
POST   /api/routes/:id/withdraw        撤回（审核中/已发布）
POST   /api/routes/:id/feature         精选（审核员）
GET    /api/versions/:id               版本视图（撤回 410 仅状态说明）
GET    /api/featured                   活跃精选卡（发布快照）
GET    /api/search?q=…                 已发布搜索
POST   /api/admin/pump                 驱动一轮后台任务（{failTimes} 模拟故障）
```

所有写接口用 `x-user-id` 头标识演示用户；错误统一为 `{error, message, details}`。

## 并发与一致性要点

- **整路线乐观锁**：`geometryRev/storyRev/noteRev` 分别保护几何、故事、点位备注，
  前端整包覆盖必须带期望值；过期返回 409 引导 rebase。
- **分段合并**：顶点有稳定 id（`vertexIds`），边用 `from>to` 标识并配内容哈希（edgeEtags）。
  操作只描述“对哪个稳定顶点做什么”，不依赖数组下标，天然适配他人插删后的重放；
  当基线路段在服务端已被改写时，逐边比对得出冲突集合，而不是粗暴地让整次保存失败。
- **歇脚点重定位**：边仍在但内容变化 → 用锚点 t 与垂直偏移自动重定位（repositioned，需作者确认）；
  边被删除/重排 → detached，必须由作者在同一幂等操作里给出新坐标或删除，服务端不会静默丢弃点位。
- **审核依据不可漂移**：通过记录绑定的是版本指纹与当时完整快照；之后的任何草稿修改都是新版本，
  精选卡引用的发布快照不受影响，也拿不到未公开草稿。

## 目录

```
src/config.js       服务端权威限制/状态枚举
src/geometry.js     GeoJSON 校验、有界/复杂度/自交、锚点投影与还原、边指纹
src/merge.js        顶点操作纯函数、同边冲突检测、歇脚点重定位
src/validation.js   文本/歇脚点/照片入站校验
src/hash.js         规范化版本指纹
src/services.js     版本状态机、审核、发布、精选、可见性（领域服务）
src/memory-store.js 内存仓储（事务+锁，测试默认）
src/pg-store.js     PostgreSQL 仓储（行锁/advisory lock/事务）
src/worker.js       outbox 后台任务：退避重试、索引物化
src/server.js       零依赖 HTTP API + 静态托管
src/schema.sql      PG 表结构
src/static/         前端单页
test/               38 个测试
```

## 测试对应的验收点

`test/acceptance.test.js` 逐项覆盖：同时编辑同路段、离线重送、审核/撤回竞争（双向）、
自交折线、照片未传完、后台发布+索引失败重试、精选必有完整审核依据、坐标有界与复杂度、
审核中改危险路口的分支与 410 留痕、撤回后精选失活/搜索移除/草稿不泄漏、
路段插删后歇脚点 repositioned/detached、指纹不匹配拒绝裁决、整路线乐观锁。
`test/http.test.js` 在真实 HTTP 端口上复验错误码、幂等头与 410 响应体。
