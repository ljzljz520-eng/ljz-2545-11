-- 慢行站路线投稿：草稿分支 / 发布版 / 审核依据 / 精选快照 / 可重试 outbox
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('author','reviewer')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routes (
  id                    TEXT PRIMARY KEY,
  author_id             TEXT NOT NULL REFERENCES users(id),
  draft_version_id      TEXT,
  current_published_id  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_routes_author ON routes(author_id);

-- 一个 route 的多版本：草稿分支(parent_version_id)与发布版不可变记录并存
CREATE TABLE IF NOT EXISTS route_versions (
  id                 TEXT PRIMARY KEY,
  route_id           TEXT NOT NULL REFERENCES routes(id),
  author_id          TEXT NOT NULL REFERENCES users(id),
  parent_version_id  TEXT REFERENCES route_versions(id),
  status             TEXT NOT NULL CHECK (status IN
                         ('draft','in_review','approved','published','rejected','withdrawn')),
  title              TEXT NOT NULL,
  story              TEXT NOT NULL,
  geometry           JSONB NOT NULL,        -- {type,coordinates,vertexIds}
  rest_points        JSONB NOT NULL DEFAULT '[]',
  photo_ids          JSONB NOT NULL DEFAULT '[]',
  edge_tags          JSONB NOT NULL DEFAULT '{}',
  fingerprint        TEXT NOT NULL,         -- 审核锁定的“几何+文字”确定版本
  geometry_rev       INTEGER NOT NULL DEFAULT 1,
  story_rev          INTEGER NOT NULL DEFAULT 1,
  note_rev           INTEGER NOT NULL DEFAULT 1,
  submitted_at       TIMESTAMPTZ,
  decided_at         TIMESTAMPTZ,
  published_at       TIMESTAMPTZ,
  withdrawn_at       TIMESTAMPTZ,
  withdraw_reason    TEXT,
  reject_reason      TEXT,
  review_id          TEXT,
  superseded_by_id   TEXT,
  index_state        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_versions_route ON route_versions(route_id);
CREATE INDEX IF NOT EXISTS idx_versions_status ON route_versions(status);

CREATE TABLE IF NOT EXISTS reviews (
  id           TEXT PRIMARY KEY,
  version_id   TEXT NOT NULL REFERENCES route_versions(id),
  route_id     TEXT NOT NULL,
  reviewer_id  TEXT NOT NULL REFERENCES users(id),
  action       TEXT NOT NULL CHECK (action IN ('approve','reject')),
  reason       TEXT NOT NULL,             -- 理由必须留痕
  fingerprint  TEXT NOT NULL,             -- 审核依据针对的确定版本
  snapshot     JSONB NOT NULL,            -- 当时几何/文字/歇脚点完整快照
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE route_versions ADD CONSTRAINT fk_review FOREIGN KEY (review_id)
  REFERENCES reviews(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  author_id  TEXT NOT NULL REFERENCES users(id),
  filename   TEXT NOT NULL,
  bytes      BIGINT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('uploading','ready')),
  ready_at   TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 精选卡：只引用发布快照与审核依据，撤回后卡片失活但保留状态说明
CREATE TABLE IF NOT EXISTS featured_cards (
  id                  TEXT PRIMARY KEY,
  route_id            TEXT NOT NULL,
  version_id          TEXT NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  reason              TEXT NOT NULL,
  snapshot            JSONB NOT NULL,
  review_basis        JSONB NOT NULL,
  deactivated_reason  TEXT,
  deactivated_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_featured_active ON featured_cards(active);

-- 后台发布/索引任务：唯一去重键 + 退避重试
CREATE TABLE IF NOT EXISTS outbox (
  id           TEXT PRIMARY KEY,
  task         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  dedupe_key   TEXT UNIQUE,
  status       TEXT NOT NULL CHECK (status IN ('pending','running','done','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  result       TEXT,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, run_after);

CREATE TABLE IF NOT EXISTS processed_batches (
  batch_key  TEXT PRIMARY KEY,  -- routeId#clientOpId，离线重送幂等
  response   JSONB NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS search_index (
  route_id   TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  title      TEXT NOT NULL,
  snippet    TEXT,
  points     TEXT,
  tsv        TSVECTOR
);
CREATE INDEX IF NOT EXISTS idx_search_tsv ON search_index USING gin(tsv);
