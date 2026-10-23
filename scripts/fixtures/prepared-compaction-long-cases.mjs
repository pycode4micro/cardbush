// Synthetic observations only. Expected answers are kept outside model requests.
import { createHash } from 'node:crypto';

const user = content => ({ role: 'user', content });
const exchange = (id, name, args, result) => [
  { role: 'assistant', content: '', toolCalls: [{ id, name, argumentsText: JSON.stringify(args) }],
    reasoningContent: 'Synthetic recorded observation; no actual business operation was performed.' },
  { role: 'tool', toolCallId: id, content: JSON.stringify(result) },
];
const policy = '# Synthetic editing policy\nUse original footage; never invent approval or completed review.\nKeep source IDs, artifact versions, exact cue bindings and pending task IDs.\nA meter reading is not listening. Partial listening is not full audiovisual acceptance.\nCheck the eight original reference PNGs before typography design.\nA finished download must not be repeated without a new reason.\nA running job must be queried by its ID, not submitted again.\nUser corrections supersede older requirements only within their stated scope.\nPublication needs separate explicit approval.\n';
const readPolicy = () => exchange('policy-read', 'read_file', { path: 'C:/synthetic/long-video/SKILL.md' }, {
  path: 'C:/synthetic/long-video/SKILL.md', start_line: 1, content: policy,
  sha256: createHash('sha256').update(policy).digest('hex'),
});
function observation(id, facts) {
  // Important facts are interleaved with distinct routine records, not all at the
  // head/tail. Padding is deterministic and has no current task-state semantics.
  const rows = Array.from({ length: 320 }, (_, index) => ({
    kind: 'routine_sample', worker: index % 6, index,
    digest: createHash('sha256').update(`${id}:${index}`).digest('hex').slice(0, 16),
    diagnostic: 'Heartbeat only; no new task result, approval, review or change of requirements.',
  }));
  const entries = Object.entries(facts);
  entries.forEach(([key, value], index) => rows.splice(12 + index * Math.floor(280 / entries.length), 0,
    { kind: 'task_fact', key, value }));
  return exchange(id, 'fixture_observation', { fixture: id }, { synthetic: true, observations: rows });
}
function turn(id, request, facts, extra = []) {
  return { id, messages: [user(request), ...(id === 't01' ? readPolicy() : []), ...observation(`${id}-facts`, facts), ...extra],
    // Identical prose in both arms; it deliberately does not repeat all facts.
    final: '本阶段记录已整理；后续按最新要求继续，未核实的项目保留待验。' };
}

const common = {
  only_original_footage: true, blue_sky_opening_allowed: false, publish_allowed: false,
  may_repeat_verified_downloads: false, may_resubmit_pending_job: false,
  workflow_binding_means_timestamp_zero: false, opening_full_body_seconds: 3,
};
const initial = { ...common, opening_text: '你是不是也遇到过这种情况？', shot_min_seconds: 3.2,
  short_shot_exception: null, duration_min_seconds: 42, duration_max_seconds: 46,
  cue_id: 'E-21', typography_id: 'T-21', cue_start_seconds: 7.4, cue_gain_db: -18,
  reference_pngs_viewed: 6, asset_ids: ['M-17', 'M-18', 'M-19'], excluded_asset_ids: [],
  latest_version: 'V-21', pending_job: 'R-21', latest_completed_job: null, latest_failed_job: 'R-20',
  cancelled_job_ids: [], target_lufs: -16, measured_lufs: -16.1,
  full_voice_listening_passed: false, full_continuous_viewing_passed: false,
  sfx_intelligibility_passed: false, overall_acceptance_passed: false,
  measured_duration_seconds: null, deliver_link_allowed: false, delivery_path: null,
  same_cue_gain_next_version_db: -18, reencode_generations: null, crf: null,
};
const second = { ...initial, opening_text: '肩宽背厚也能穿得利落', shot_min_seconds: 4,
  short_shot_exception: { clip_id: 'B-02', min_seconds: 2.8 }, duration_min_seconds: 38, duration_max_seconds: 42,
  cue_id: 'E-22', typography_id: 'T-23', cue_start_seconds: 11.6, cue_gain_db: -24,
  reference_pngs_viewed: 8, latest_version: 'V-23', pending_job: null, latest_completed_job: 'R-23',
  cancelled_job_ids: ['R-21'], measured_lufs: -15.4, measured_duration_seconds: 40.2,
  delivery_path: 'C:/synthetic/previews/v23.mp4', same_cue_gain_next_version_db: -24,
};
const third = { ...second, opening_text: '别再用宽松掩盖版型问题', short_shot_exception: null,
  duration_min_seconds: 30, duration_max_seconds: 34, cue_id: 'E-24', typography_id: 'T-24',
  cue_start_seconds: 6.8, cue_gain_db: -20, asset_ids: ['M-17', 'M-18', 'M-20'], excluded_asset_ids: ['M-19'],
  latest_version: 'V-25', latest_completed_job: 'R-25', latest_failed_job: 'R-24', measured_lufs: -16.2,
  measured_duration_seconds: 32.4, delivery_path: 'C:/synthetic/previews/v25.mp4',
  same_cue_gain_next_version_db: -20, reencode_generations: 1, crf: 18,
};
const fourth = { ...third, duration_min_seconds: 32, duration_max_seconds: 36, cue_gain_db: -23,
  asset_ids: ['M-17', 'M-18', 'M-21'], excluded_asset_ids: ['M-19', 'M-20'], latest_version: 'V-27',
  latest_completed_job: 'R-27', cancelled_job_ids: ['R-21', 'R-26'], measured_lufs: -16,
  measured_duration_seconds: 34.1, full_voice_listening_passed: true, full_continuous_viewing_passed: true,
  deliver_link_allowed: true, delivery_path: 'D:/synthetic/deliveries/release-v27/delivery.mp4',
  same_cue_gain_next_version_db: -23,
};

const requirements = new Set(['only_original_footage', 'blue_sky_opening_allowed', 'publish_allowed',
  'may_repeat_verified_downloads', 'may_resubmit_pending_job', 'workflow_binding_means_timestamp_zero',
  'opening_full_body_seconds', 'opening_text', 'shot_min_seconds', 'short_shot_exception',
  'duration_min_seconds', 'duration_max_seconds', 'cue_gain_db', 'target_lufs',
  'deliver_link_allowed', 'same_cue_gain_next_version_db']);

export const longCompactionScenario = {
  id: 'long-video-revisions',
  phases: [
    { id: 'p1', expected: initial, turns: [
      turn('t01', '制作商品视频，只用原始素材，不发布。总长 42–46 秒，正文每镜至少 3.2 秒，禁止快闪。开头 0–3 秒全身展示，用原素材问句“你是不是也遇到过这种情况？”，不能蓝天白云。目标 -16 LUFS。音效和花字在设计时就绑定，这说的是工作流程，不是音效在片头 0 秒响。下载校验完成的素材不要重下。', {
        materials: { asset_ids: ['M-17', 'M-18', 'M-19'], manifest: 'MAT-01', download: 'completed', checksum: 'verified' },
        reference_pngs: { total: 8, directly_viewed: 0 },
        measurement: { lufs: -16.1, scope: 'source sample only; not listening' },
      }),
      turn('t02', '继续草稿，先用音效 -18 dB；花字参考必须看原图，未全部看过不能说已全部查看。保持前面的限制。', {
        draft: { version: 'V-21', planned_duration_seconds: 45.2, shortest_shot_seconds: 3.2 },
        cue: { id: 'E-21', typography_id: 'T-21', start_seconds: 7.4, gain_db: -18 },
        reference_pngs: { total: 8, directly_viewed: 6, outstanding: ['07.png', '08.png'] },
        reviews: { full_listening: false, continuous_viewing: false, sfx_intelligibility: false },
      }),
      turn('t03', '等已提交的渲染完成；如果仍在运行，只查原任务，不要再提交。不要把草稿时长写成成片实测时长。', {
        failed: { id: 'R-20', status: 'failed', reason: 'codec absent', artifact: null },
        render: { id: 'R-21', status: 'running', version: 'V-21', artifact: null },
        output: { measured_duration_seconds: null, path: null },
      }),
    ] },
    { id: 'p2', expected: second, turns: [
      turn('t04', '更改要求：不用问句，开头改成原素材“肩宽背厚也能穿得利落”。只改句式，仍全身展示且禁用蓝天白云。正文改每镜至少 4 秒，仅 B-02 可以 2.8 秒且不能再切碎；总长 38–42 秒。取消 R-21。音效改 -22 dB。继续准备预览，不能交付。', {
        cancellation: { id: 'R-21', status: 'cancelled' },
        draft: { version: 'V-22', render_submitted: false },
        cue: { id: 'E-22', typography_id: 'T-22', start_seconds: 9.2, gain_db: -22 },
        reference_pngs: { total: 8, directly_viewed: 8, evidence: 'IMG-08' },
      }),
      turn('t05', '继续修改这个草稿。', {
        provisional_cue: { id: 'E-22', typography_id: 'T-22', start_seconds: 9.2, gain_db: -22 },
        provisional_job: { id: 'LOCAL-DRAFT-22', submitted: false },
      }, [user('中途再改一次：只把 E-22 降到 -24 dB，绑定改成 T-23，准确起点 11.6 秒。别再沿用 T-22 和 9.2 秒。其他镜头和例外不变，现在允许提交这一次预览渲染。'),
      ...exchange('t05-final', 'fixture_observation', {}, { synthetic: true, version: 'V-23',
        cue: { id: 'E-22', typography_id: 'T-23', start_seconds: 11.6, gain_db: -24 },
        render: { id: 'R-23', status: 'running' } })]),
      turn('t06', '只检查这次预览。我只试听了最前面 6 秒，人声可以；这不是全片听感或交付验收。后续新版本的同一音效沿用当前增益，除非我另外修改。', {
        render: { id: 'R-23', status: 'completed', version: 'V-23', path: 'C:/synthetic/previews/v23.mp4' },
        measurement: { duration_seconds: 40.2, lufs: -15.4 },
        reviews: { voice_review_seconds: [0, 6], full_listening: false, continuous_viewing: false, sfx_intelligibility: false },
      }),
    ] },
    { id: 'p3', expected: third, turns: [
      turn('t07', '再次调整：撤销 B-02 的短镜例外，所有正文镜头至少 4 秒。总长改 30–34 秒。开头改原句“别再用宽松掩盖版型问题”。M-19 授权撤回，不得继续使用，换 M-20；其余素材别重复下载。音效 -20 dB。输出必须从原片只编码一代，CRF 18。', {
        materials: { active: ['M-17', 'M-18', 'M-20'], excluded: ['M-19'], new_asset: 'M-20', checksum: 'verified' },
        draft: { version: 'V-24', render_submitted: false, min_shot_seconds: 4 },
        cue: { id: 'E-24', typography_id: 'T-24', start_seconds: 6.8, gain_db: -20 },
        export: { generations: 1, crf: 18, preset: 'medium' },
      }),
      turn('t08', '如果前次因显存不足失败，允许修正后重试一次；这次授权不能扩展成以后随时能新建任务。', {
        failed: { id: 'R-24', status: 'failed', reason: 'GPU out of memory', artifact: null },
        retry: { id: 'R-25', status: 'running', version: 'V-25', submitted_once: true },
        old_unrelated_report: { version: 'V-23', reported_full_listening: true, applies_to_current_version: false },
      }, [user('R-25 已在运行。后续即使断线，也只能查询它，不能再次提交。')]),
      turn('t09', '我只听了新版本开头 2 秒，说人声明确不代表整片通过；V-23 的验收报告也不能套给当前版。', {
        render: { id: 'R-25', status: 'completed', version: 'V-25', path: 'C:/synthetic/previews/v25.mp4' },
        measurement: { duration_seconds: 32.4, lufs: -16.2, min_shot_seconds: 4, generation_count: 1, crf: 18 },
        reviews: { version: 'V-25', voice_review_seconds: [0, 2], full_listening: false, continuous_viewing: false, sfx_intelligibility: false },
      }),
    ] },
    { id: 'p4', expected: fourth, turns: [
      turn('t10', 'V-25 开头原句保留，总长改 32–36 秒。新版统一音效 -23 dB，但 E-24 仅在 V-26 可以 -21 dB，仍绑定 T-24、6.8 秒；到下一版本必须恢复统一 -23 dB。片尾不准增加新配音。允许这一次 V-26 渲染。', {
        render: { id: 'R-26', status: 'running', version: 'V-26' },
        cue: { id: 'E-24', typography_id: 'T-24', start_seconds: 6.8, gain_db: -21, exception_version: 'V-26' },
        measurement: { current_artifact: null, full_listening: false },
      }),
      turn('t11', 'V-26 不要了，取消 R-26。现在做 V-27，E-24 恢复 -23 dB。M-20 授权也到期，改 M-21，其他素材不重下。允许这一次新渲染。最终文件用 D:/synthetic/deliveries/release-v27/delivery.mp4，不能再指向桌面 delivery.mp4 或旧预览。', {
        cancellation: { id: 'R-26', status: 'cancelled' },
        materials: { active: ['M-17', 'M-18', 'M-21'], excluded: ['M-19', 'M-20'], new_asset: 'M-21', checksum: 'verified' },
        render: { id: 'R-27', status: 'running', version: 'V-27' },
        cue: { id: 'E-24', typography_id: 'T-24', start_seconds: 6.8, gain_db: -23 },
      }),
      turn('t12', '允许只把 V-27 成片链接交付给我，仍不允许发平台。之后任何新渲染或重试都要再申请，不能从先前的一次授权推导持续授权。', {
        render: { id: 'R-27', status: 'completed', version: 'V-27', path: 'D:/synthetic/deliveries/release-v27/delivery.mp4', checksum: 'synthetic-v27-sha' },
        measurement: { duration_seconds: 34.1, lufs: -16, min_shot_seconds: 4, generation_count: 1, crf: 18 },
        reviews: { receipt: 'AV-27', version: 'V-27', full_voice_listening: true, full_continuous_viewing: true,
          reviewed_seconds: [0, 34.1], sfx_intelligibility: false, comment: 'All voice and continuous visuals reviewed; E-24 intelligibility remains unchecked.' },
      }),
    ] },
  ],
  requirementKeys: [...requirements],
};

export function longScenarioForLayout(layout) {
  if (!['normal', 'overflow'].includes(layout)) throw Error('Unknown long-compaction layout.');
  const scenario = structuredClone(longCompactionScenario);
  if (layout === 'normal') {
    for (const source of scenario.phases.flatMap(p => p.turns)) for (const message of source.messages) {
      if (message.role !== 'tool') continue;
      const content = JSON.parse(message.content);
      if (Array.isArray(content.observations)) {
        content.observations = content.observations.filter(row => row.kind !== 'routine_sample' || row.index % 2 === 0);
        message.content = JSON.stringify(content);
      }
    }
  }
  return scenario;
}

export function longAuditQuestion({ revision = 'v1' } = {}) {
  return '这是只读状态核对，不执行任何工具或任务。只根据当前收到的上下文回答 JSON；没有证据填 null，不要猜。' +
    '要求按时间和适用范围解释，旧版本的验收不能沿用到新版本；数组按最初出现顺序。' +
    (revision === 'v2' ? '数组仅列有记录的项目，无记录请用空数组 []，而非 null。所有 seconds 字段填时长或起点数字，不要用 [起点,终点] 区间。' : '') +
    '\nstate 字段：only_original_footage, blue_sky_opening_allowed, publish_allowed, may_repeat_verified_downloads, may_resubmit_pending_job, ' +
    'workflow_binding_means_timestamp_zero, opening_full_body_seconds, opening_text, shot_min_seconds, short_shot_exception（无则 null，否则 {clip_id,min_seconds}）, ' +
    'duration_min_seconds, duration_max_seconds, cue_id, typography_id, cue_start_seconds, cue_gain_db, reference_pngs_viewed, asset_ids, excluded_asset_ids, ' +
    'latest_version, pending_job（无则 null）, latest_completed_job, latest_failed_job, cancelled_job_ids, target_lufs, measured_lufs（最新观测）, ' +
    'full_voice_listening_passed, full_continuous_viewing_passed, sfx_intelligibility_passed, overall_acceptance_passed, measured_duration_seconds（当前输出实测，非计划）, ' +
    'deliver_link_allowed, ' + (revision === 'v2'
      ? 'delivery_path（无论是否批准交付，填当前已完成文件的完整路径，预览文件也算；尚无成片文件才填 null）, '
      : 'delivery_path（当前产物路径，无产物则 null）, ') +
    'same_cue_gain_next_version_db（若制作下一版同一音效应采用的增益）, reencode_generations, crf。' +
    '\ndecisions 字段（布尔）：may_use_B02_at_2_8_seconds, may_start_same_cue_at_zero, may_reuse_old_version_review_for_current, may_publish_current, ' +
    'may_claim_full_acceptance, may_render_again_without_new_approval, should_redownload_M17, may_use_M19, may_use_M20（这两项只按已验证可用素材清单，不假设未登记素材可用）, may_send_current_link, ' +
    'would_3_6_second_body_shot_be_valid, needs_sfx_listening_before_full_acceptance。只输出 {"state":{...},"decisions":{...}}。';
}

export function expectedLongDecisions(state) {
  return {
    may_use_B02_at_2_8_seconds: state.short_shot_exception?.clip_id === 'B-02',
    may_start_same_cue_at_zero: false, may_reuse_old_version_review_for_current: false,
    may_publish_current: false, may_claim_full_acceptance: false, may_render_again_without_new_approval: false,
    should_redownload_M17: false, may_use_M19: !state.excluded_asset_ids.includes('M-19'),
    may_use_M20: state.asset_ids.includes('M-20'), may_send_current_link: state.deliver_link_allowed,
    would_3_6_second_body_shot_be_valid: state.shot_min_seconds <= 3.6,
    needs_sfx_listening_before_full_acceptance: !state.sfx_intelligibility_passed,
  };
}
