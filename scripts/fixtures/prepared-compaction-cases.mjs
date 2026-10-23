import { createHash } from 'node:crypto';

const user = content => ({ role: 'user', content });
const exchange = (id, name, args, result) => [
  { role: 'assistant', content: '', reasoningContent: 'Synthetic fixture: observation requested; no real business operation was performed.',
    toolCalls: [{ id, name, argumentsText: JSON.stringify(args) }] },
  { role: 'tool', toolCallId: id, content: JSON.stringify(result) },
];
const source = (id, path, content) => exchange(id, 'read_file', { path }, {
  path, sha256: createHash('sha256').update(content).digest('hex'), start_line: 1, content,
});
const noise = Array.from({ length: 550 }, (_, index) => `Routine sample ${index}: worker alive; unchanged counters; no approval or new completion evidence.`).join('\n');
const logged = (id, result) => exchange(id, 'fixture_observation', {}, { synthetic: true, ...result, routine_log: noise });

export const preparedCompactionCases = [
  {
    id: 'video',
    turns: [
      { id: 'materials', messages: [user('制作商品视频：只用原素材，不发布。先准备素材并做时间线草稿。下载完成后不要重复下载。'),
        ...source('video-rules', 'C:/synthetic/video/SKILL.md', '# Video policy\n每个正文镜头至少 3.2 秒；禁止快闪。\n未实际试听，不能声称听感通过。\n音效必须绑定花字的时间和 ID。\n不要用文字或 OCR 替代查看花字参考原图。\n发布始终需要明确授权。\n'),
        ...logged('assets', { assets: ['A-17', 'A-18'], checksums: 'verified',
          typographyReferences: 'eight PNGs listed but not yet viewed',
          measuredLoudness: '-16.1 LUFS; this is measurement only, no listening',
          draft: 'D-9; minimum shot length 3.2 seconds; not approved for delivery' })],
        final: '素材准备完成，时间线仍是草稿；还有检查待做。' },
      { id: 'revision', messages: [user('开头更正：用原素材中的问句，不要陈述句或蓝天白云。保持全身展示，音效和花字在一开始就绑定，不能靠最后返修。'),
        ...logged('render', { version: 'V-12', previousJob: { id: 'R-11', status: 'failed', reason: 'missing codec; no output' },
          currentJob: { id: 'R-12', status: 'running', poll: 'query R-12; do not resubmit' },
          opening: { question: '你是不是也遇到过这种情况？', fullBodySeconds: 3.6, background: 'original shop floor' },
          cue: { id: 'E-12', typographyId: 'T-12', startSeconds: 7.4, gainDb: -18 },
          checks: { minShotSeconds: 3.2, listening: 'not done', eightPNGsViewed: false } })],
        final: '修改已提交，正在等待现有任务完成；尚未交付。' },
    ],
    question: '只根据已有记录返回 JSON，不调用工具、不执行操作。字段：asset_ids（数组）、failed_job、pending_job、may_resubmit（布尔）、version、min_shot_seconds（数字）、sfx_gain_db（数字）、sfx_start_seconds（数字）、typography_id、listening_passed（布尔）、reference_images_viewed（布尔）、may_publish（布尔）、opening_full_body_seconds（数字）。未知填 null。',
    expected: { asset_ids: ['A-17', 'A-18'], failed_job: 'R-11', pending_job: 'R-12', may_resubmit: false,
      version: 'V-12', min_shot_seconds: 3.2, sfx_gain_db: -18, sfx_start_seconds: 7.4, typography_id: 'T-12',
      listening_passed: false, reference_images_viewed: false, may_publish: false, opening_full_body_seconds: 3.6 },
    staleCorrection: '刚收到补充：R-12 已取消，禁止继续等待它。新的草稿版本是 V-13，但没有提交任何新渲染；绝对不能把旧摘要当成当前状态。',
    staleExpected: { pending_job: null, may_resubmit: false, version: 'V-13' },
  },
  {
    id: 'deployment',
    turns: [
      { id: 'install', messages: [user('在隔离账号安装服务，只检查与准备；保留沙盒，未经授权不要重启，也不要开放公网端口。'),
        ...source('deploy-rules-v1', 'C:/synthetic/deploy/SKILL.md', '# Deployment policy\n使用隔离账号运行。\n必须保留进程资源保护。\n配置备份保留到回滚验证完成。\n检查状态不能推断为部署成功。\n'),
        ...logged('install-result', { account: 'cardbush-agent', service: 'AgentB', port: 4781, bind: '127.0.0.1',
          configBackup: 'C:/synthetic/backups/config-19.json', processHost: 'present, signature verified',
          installJob: { id: 'I-301', status: 'completed' }, restartApproved: false })],
        final: '安装准备已完成。服务仍保持原状态。' },
      { id: 'config', messages: [user('配置不重启，等空闲后提交。目录改用 D:/jobs/111，旧的 C:/work 不再适用。'),
        ...source('deploy-rules-v2', 'C:/synthetic/deploy/SKILL.md', '# Deployment policy v2\n仍使用隔离账号并保留进程保护。\n同步遇到 busy 时延后，不能中断正在执行的任务。\n只有 applied 才是已提交；pending 不是失败。\n备份在回滚验证前不得删除。\n'),
        ...logged('config-result', { transaction: 'CFG-44', status: 'pending', reason: 'Agent busy with JOB-77',
          activeJob: 'JOB-77', previousAttempt: { id: 'CFG-43', status: 'failed', rollback: 'verified' },
          workspace: 'D:/jobs/111', shell: 'PowerShell 7.4', currentVersion: 'C-19', pendingVersion: 'C-20',
          backupMustKeep: 'C:/synthetic/backups/config-19.json', desktop: 'not probed; unknown, not proven unavailable',
          applied: false, restartApproved: false })],
        final: '新配置在等待任务结束，尚未提交。' },
    ],
    question: '只根据已有记录返回 JSON，不调用工具、不执行操作。字段：account、service、port（数字）、bind、install_job、config_transaction、config_status、busy_job、workspace、shell、current_version、pending_version、backup、restart_approved（布尔）、config_applied（布尔）、desktop_state（用 unknown/available/unavailable）。未知填 null。',
    expected: { account: 'cardbush-agent', service: 'AgentB', port: 4781, bind: '127.0.0.1', install_job: 'I-301',
      config_transaction: 'CFG-44', config_status: 'pending', busy_job: 'JOB-77', workspace: 'D:/jobs/111', shell: 'PowerShell 7.4',
      current_version: 'C-19', pending_version: 'C-20', backup: 'C:/synthetic/backups/config-19.json',
      restart_approved: false, config_applied: false, desktop_state: 'unknown' },
  },
];
