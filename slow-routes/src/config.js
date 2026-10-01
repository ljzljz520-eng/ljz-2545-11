'use strict';
// 全部限制集中在此。服务端强制，不相信客户端检查。
module.exports = Object.freeze({
  PORT: Number(process.env.PORT || 3000),
  DATABASE_URL: process.env.DATABASE_URL || '',
  EMBEDDED: {
    enabled: !process.env.DATABASE_URL,          // 有外部 PG 就不起内嵌实例
    version: '16.4.0',
    port: Number(process.env.PG_PORT || 55432),
    clusterDir: process.env.PG_DATA || '/workspace/slow-routes/data/db',
    user: 'node',
    password: 'slowroutes'
  },
  LIMITS: Object.freeze({
    MIN_POINTS: 2,
    MAX_POINTS: 500,                 // 折线复杂度上限（顶点）
    MAX_STOPS: 50,
    MAX_SEGMENT_LEN_M: 50000,        // 单段长度上限 50km，防止穿越式折线
    MAX_TOTAL_LEN_M: 500000,         // 总长上限 500km
    MIN_SEGMENT_LEN_M: 0.5,          // 相邻点过近 => 拒绝（防止脏数据）
    MAX_DECIMALS: 7,                 // 坐标最多 7 位小数
    LNG_MIN: 73.0, LNG_MAX: 135.1,   // 中国大致范围（服务端边界）
    LAT_MIN: 18.0, LAT_MAX: 53.6,
    TITLE_MIN: 2, TITLE_MAX: 80,
    STORY_MAX: 5000,
    STOP_NAME_MAX: 60,
    STOP_NOTE_MAX: 500,
    REASON_MAX: 1000,
    COMMENT_MAX: 2000,
    BLURB_MAX: 200,
    PHOTO_MAX_BYTES: 5 * 1024 * 1024,
    ANCHOR_DRIFT_M: 25,              // 段几何改动后，锚点投影漂移超过此值 => 需重新定位
  }),
  JOB: {
    POLL_MS: 200,
    BACKOFF_BASE_MS: 200             // 指数退避基数
  }
});
