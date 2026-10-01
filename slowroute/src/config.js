// 服务端权威限制：客户端检查只是体验优化，真正的边界与复杂度校验都在这里。
export const LIMITS = Object.freeze({
  // 中国境内常见经纬度范围（慢行走廊再收紧一点），坐标必须有界。
  LNG_MIN: 73.0,
  LNG_MAX: 135.5,
  LAT_MIN: 3.0,
  LAT_MAX: 54.0,
  MIN_VERTICES: 2,
  MAX_VERTICES: 500, // 折线复杂度上限
  MAX_REST_POINTS: 100,
  MAX_STORY_CHARS: 4000,
  MAX_TITLE_CHARS: 120,
  MAX_REASON_CHARS: 1000,
  MAX_NOTE_CHARS: 500,
  COORD_DECIMALS: 6,
  MIN_SEGMENT_METERS: 1.0, // 相邻点过近视为退化/重复
  MAX_TOTAL_KM: 300, // 单条慢行路线合理总长
  OFFSET_TOL_METERS: 25, // 歇脚点偏离所属路段的容忍距离
  MAX_OPEN_SUBMISSIONS_PER_ROUTE: 1,
  MAX_REVIEW_ATTEMPTS: 5, // 后台任务重试上限
  WORKER_POLL_MS: 500
});

export const ROLES = Object.freeze({ AUTHOR: 'author', REVIEWER: 'reviewer' });

// 版本状态机：
// draft（草稿分支，可继续编辑）
// in_review（提交审核，几何与文字版被冻结并绑定审核依据）
// approved（审核通过，可发布；草稿再次改动不会沿用这份同意）
// published（发布版，不可变，精选卡引用其快照）
// rejected（驳回，带理由）
// withdrawn（作者撤回；旧链接保留状态说明）
export const VERSION_STATUS = Object.freeze({
  DRAFT: 'draft',
  IN_REVIEW: 'in_review',
  APPROVED: 'approved',
  PUBLISHED: 'published',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn'
});

// outbox 任务类型：发布与搜索索引更新均走可重试的后台通道
export const TASK = Object.freeze({
  PUBLISH_INDEX: 'publish_index',
  SEARCH_INDEX: 'search_index',
  UNPUBLISH_INDEX: 'unpublish_index'
});
