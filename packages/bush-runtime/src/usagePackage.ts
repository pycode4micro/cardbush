import { createHash } from 'node:crypto';
import type { UsageDefinition } from '@cardbush/bush-protocol';

/** The existing definition remains canonical; Markdown is an exported reading view. */
export function usageManual(pack: UsageDefinition): string {
  const lines = [`# ${pack.name}`, '', pack.objective, '', '## 默认计划', '',
    ...pack.plan.map((id, index) => `${index + 1}. ${pack.nodes.find(node => node.id === id)!.name}（${id}）`), '',
    '由用户选择本手册。默认复用上述节点，通过 CardBush 自己的 update_task_plan 更新进度；可按实际任务调整参数和计划，保留仍适用的节点引用。', '',
    ...pack.constraints.flatMap(item => [`> ${item.text}`, `来源：${item.source}`, ''])];
  for (const node of pack.nodes) {
    lines.push(`## ${node.name} [${node.id}]`, '', node.instruction, '');
    for (const decision of node.decisions) {
      lines.push(`适用情况：${decision.situation}`, `做法：${decision.choice}`, `理由与取舍：${decision.reason}`, '');
      for (const alternative of decision.alternatives) lines.push(`- 替代方向：${alternative.choice}；取舍：${alternative.tradeoff}`);
      for (const parameter of decision.parameters) lines.push(`- 参数 ${parameter.name}：依据 ${parameter.derive_from}；调整条件：${parameter.adjust_when}`);
      lines.push('');
    }
    for (const example of node.examples) lines.push(`示例：${example.situation}`,
      ...example.steps.map(step => `- ${step.observation}`), `经验：${example.lesson}`, '');
    if (node.adaptation.length) lines.push('调整方法：', ...node.adaptation.map(value => `- ${value}`), '');
    if (node.checks.length) lines.push('完成条件与检查：', ...node.checks.map(value => `- ${value}`), '');
  }
  lines.push('## 使用与扩展', '', '本包仅声明方法，不证明教师示例的质量。工具能力、文件和参数以当前环境为准。',
    '可在 commands/use.md 的 hooks 中声明 CardBush 原生事件处理。PreToolUse 阻止条件属于 guard，必须同步执行并在插件设置中信任后才能加载。其他 Command 可放入 commands/；封装方法继续使用 recipes 与 run_tools。',
    '安装不自动启用。使用 /包名:use 加载，使用 /包名:stop 停用；压缩后按原生计划恢复当前节点。', '');
  return lines.join('\n');
}

export function exportUsagePackage(pack: UsageDefinition) {
  const pluginId = `usage-${pack.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 56)}-${createHash('sha256').update(pack.id).digest('hex').slice(0, 8)}`;
  const overview = [`# ${pack.name}`, '', pack.objective, '',
    '已由用户选择此 usage。先阅读以下总览，并复用或调整运行时提供的 plan_template。所有进度使用 update_task_plan；当前节点指导会自动恢复。',
    '完整手册位于插件根目录 usage.md。执行用户传入的任务参数：$ARGUMENTS', '',
    ...pack.plan.map((id, index) => `${index + 1}. ${pack.nodes.find(node => node.id === id)!.name} [${id}]`)];
  return {
    format: 'cardbush-plugin', plugin_id: pluginId, activation: `/${pluginId}:use`, deactivation: `/${pluginId}:stop`,
    files: [
      { path: '.codex-plugin/plugin.json', content: JSON.stringify({ name: pluginId, version: '1.0.0', description: pack.objective, commands: './commands' }, null, 2) },
      { path: 'usage.json', content: JSON.stringify(pack, null, 2) },
      { path: 'usage.md', content: usageManual(pack) },
      { path: 'commands/use.md', content: `---\ndescription: ${JSON.stringify(pack.name)}\ndisable-model-invocation: true\nusage: ./usage.json\n---\n${overview.join('\n')}\n` },
      { path: 'commands/stop.md', content: '---\ndescription: 停用当前手册\ndisable-model-invocation: true\nusage:\n  file: ./usage.json\n  action: unload\n---\n已按用户要求停用此手册。保留原生计划，由当前任务决定如何继续。\n' },
    ],
    note: 'Write these files under one directory, include assets_to_package at their relative paths, then install the directory or ZIP through CardBush plugin installation. Export itself does not write files, install plugins or run hooks. Existing usage JSON import/export stays supported.',
  };
}
