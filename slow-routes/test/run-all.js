'use strict';
// 串行执行 7 个验收场景；每个场景使用独立的内嵌 PostgreSQL。
const { spawnSync } = require('child_process');
const path = require('path');
const scenarios = [
  ['t1_validation.js', '服务端 GeoJSON 校验'],
  ['t2_concurrency.js', '并发编辑/乐观锁/分段合并/歇脚点重定位'],
  ['t3_review.js', '审核绑定确定版本 + 审核/撤回竞争'],
  ['t4_offline_photos.js', '离线重送幂等 + 照片完整性'],
  ['t5_published_featured.js', '发布快照/撤回旧链接/精选不泄漏草稿'],
  ['t6_jobs_retry.js', '后台发布与搜索索引可重试'],
  ['t7_audit_basis.js', '完整审核依据链 + 改版重发']
];
let totalPass = 0, totalFail = 0;
for (const [f, label] of scenarios) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n').filter((l) => l.includes('  PASS') || l.includes('  FAIL'));
  const pass = lines.filter((l) => l.includes('  PASS')).length;
  const fail = lines.filter((l) => l.includes('  FAIL')).length;
  totalPass += pass; totalFail += fail;
  console.log(`${fail ? '❌' : '✅'} ${f}  ${label}  => ${pass} PASS / ${fail} FAIL`);
  if (fail) lines.filter((l) => l.includes('  FAIL')).forEach((l) => console.log('    ' + l.trim()));
  if (r.status !== 0 && pass + fail === 0) {
    console.log('    场景异常退出：' + (out.split('\n').slice(-6).join(' | ')));
    totalFail += 1;
  }
}
console.log(`\n合计 ${totalPass} PASS / ${totalFail} FAIL`);
process.exit(totalFail ? 1 : 0);
