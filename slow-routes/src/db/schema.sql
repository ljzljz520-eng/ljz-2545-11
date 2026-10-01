-- 慢行站路线投稿系统 · 数据库结构
-- PostgreSQL 14+（实际运行 PG18）。几何用 JSONB 存 GeoJSON，生产可换 PostGIS。

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('author','reviewer','admin')),
  token        TEXT NOT NULL UNIQUE
);

-- ============ 路线：草稿分支 + 当前几何/文字指纹 + 整路线乐观锁 ============
CREATE TABLE IF NOT EXISTS routes (
  id             TEXT PRIMARY KEY,
  author_id      TEXT NOT NULL REFERENCES users(id),
  title          TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','in_review','changes_requested','published','withdrawn')),
  -- 当前工作副本（草稿分支）几何与备注锚点结构
  working_geom   JSONB NOT NULL DEFAULT '{"type":"LineString","coordinates":[]}'
                 CHECK (working_geom IS NULL OR working_geom ? 'type'),
  story          TEXT,
  -- 指向当前草稿对应的不可变版本号（没提交过审核时为自身草稿版本）
  draft_version  INTEGER NOT NULL DEFAULT 1,
  -- 几何维度与文字维度的指纹，用于判断"审核绑定版本"是否被改动
  geom_fingerprint TEXT,
  text_fingerprint TEXT,
  -- 整路线保存的 ETag 风格版本（任何草稿编辑 +1），用于全量乐观锁
  route_version  BIGINT NOT NULL DEFAULT 1,
  -- 当前有效审核（无则 NULL）。有效 = 决议时几何/文字与当前草稿一致且之后未被改动
  active_review_id TEXT,
  -- 最新发布信息（head = 当前可见版本；withdrawn 仍保留旧链接与状态说明）
  published_revision_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_note TEXT
);

CREATE INDEX IF NOT EXISTS routes_author_idx ON routes(author_id);
CREATE INDEX IF NOT EXISTS structures_status_idx ON routes(status);

-- ============ 不可变版本：提交审核 / 发布的快照，及改动理由 ============
CREATE TABLE IF NOT EXISTS route_revisions (
  id             TEXT PRIMARY KEY,
  route_id       TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('submit','publish','withdraw','request_changes'))
                 DEFAULT 'submit',
  geometry       JSONB NOT NULL,
  story          TEXT,
  title          TEXT,
  stop_snapshots JSONB NOT NULL DEFAULT '[]',
  reason         TEXT,                       -- 投稿说明 / 改动理由 / 撤回理由
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  geom_fingerprint TEXT NOT NULL,
  text_fingerprint TEXT NOT NULL,
  UNIQUE (route_id, version)
);

-- ============ 细粒度合并用：工作副本中的路段（分段版本）============
-- 段由其两端点标识；顶点插入=把一段分裂成两段，顶点删除=合并相邻两段
CREATE TABLE IF NOT EXISTS route_segments (
  route_id    TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,             -- 沿折线从 0 起
  uid         TEXT NOT NULL,                -- 稳定标识，用于分段乐观锁/合并
  start_pt    JSONB NOT NULL,               -- [lng,lat]
  end_pt      JSONB NOT NULL,
  seg_version BIGINT NOT NULL DEFAULT 1,    -- 该段被改动 +1
  PRIMARY KEY (route_id, seq),
  UNIQUE (route_id, uid)
);

-- ============ 歇脚点：锚定在路段上（几何/备注依赖）============
-- anchor: {kind:'segment', uid, t}     锚到某段上的参数位置(0..1)
--         {kind:'vertex', seq}         锚到顶点
-- status:
--   ok                位置仍有效
--   needs_relocation  所属段被插删/几何漂移，等待作者重新定位
-- 依赖：段被插入/删除后，落在受影响段上的点自动转 needs_relocation
CREATE TABLE IF NOT EXISTS route_stops (
  id          TEXT PRIMARY KEY,
  route_id    TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  anchor      JSONB NOT NULL,               -- 锚定描述
  coordinates JSONB NOT NULL,               -- 缓存坐标 [lng,lat]，重定位前视为过期
  status      TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','needs_relocation')),
  UNIQUE (route_id, seq)
);
CREATE INDEX IF NOT EXISTS stops_route_idx ON route_stops(route_id, status);

-- ============ 审核：绑定"确定的几何+文字版"，带两个维度的指纹 ============
CREATE TABLE IF NOT EXISTS reviews (
  id                TEXT PRIMARY KEY,
  route_id          TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  revision_id       TEXT NOT NULL REFERENCES route_revisions(id),
  reviewer_id       TEXT NOT NULL REFERENCES users(id),
  decision          TEXT NOT NULL CHECK (decision IN ('pending','approved','rejected','changes_requested')),
  comment           TEXT,                   -- 审核理由
  -- 决议时刻绑定：必须与待审版本完全一致；之后几何或文字变了则自动失效（不能沿用旧同意）
  bound_geom_fingerprint TEXT NOT NULL,
  bound_text_fingerprint TEXT NOT NULL,
  decided_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at     TIMESTAMPTZ,            -- 作者改了危险路口等 => 该同意作废
  superseded_reason TEXT
);
CREATE INDEX IF NOT EXISTS reviews_route_idx ON reviews(route_id);

-- ============ 不可变发布：精选卡引用的就是这里的快照 ============
CREATE TABLE IF NOT EXISTS publications (
  id                TEXT PRIMARY KEY,
  route_id          TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  revision_id       TEXT NOT NULL REFERENCES route_revisions(id),
  revision_version  INTEGER NOT NULL,
  geometry          JSONB NOT NULL,          -- 不可变快照（几何/文字/歇脚点）
  title             TEXT NOT NULL,
  story             TEXT,
  stop_snapshots    JSONB NOT NULL DEFAULT '[]',
  approved_review_id TEXT NOT NULL REFERENCES reviews(id), -- 每一个发布版都有完整审核依据
  published_by      TEXT NOT NULL REFERENCES users(id),
  published_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at      TIMESTAMPTZ,                     -- 撤回后仍在！链接保留
  withdrawn_note    TEXT
);
CREATE INDEX IF NOT EXISTS publications_route_idx ON publications(route_id, published_at DESC);

-- ============ 精选卡：引用发布快照，绝不指向草稿 ============
CREATE TABLE IF NOT EXISTS featured_cards (
  id               TEXT PRIMARY KEY,
  publication_id   TEXT NOT NULL REFERENCES publications(id),
  blurb            TEXT NOT NULL,
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at       TIMESTAMPTZ
);

-- ============ 照片：上传完成登记；提交时校验全部已上传完 ============
CREATE TABLE IF NOT EXISTS photos (
  id           TEXT PRIMARY KEY,
  route_id     TEXT REFERENCES routes(id) ON DELETE CASCADE,
  author_id    TEXT NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  bytes        BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','orphan')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 可重试后台任务：发布落地 + 搜索索引更新 ============
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('publish','index','unindex')),
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','dead')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error    TEXT,
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, run_after) WHERE status IN ('pending','running');

-- ============ 公开搜索索引（后台 index 任务更新，可重试）============
CREATE TABLE IF NOT EXISTS search_index (
  route_id       TEXT PRIMARY KEY REFERENCES routes(id) ON DELETE CASCADE,
  publication_id TEXT NOT NULL REFERENCES publications(id),
  title          TEXT NOT NULL,
  tsv            TSVECTOR NOT NULL,
  indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS search_tsv_idx ON search_index USING GIN (tsv);

-- ============ 审计流：发布/撤回/精选/审核依据链 ============
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   TEXT REFERENCES users(id),
  route_id   TEXT,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 幂等键：离线重送去重 ============
CREATE TABLE IF NOT EXISTS idempotency (
  key         TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL,
  method_path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
