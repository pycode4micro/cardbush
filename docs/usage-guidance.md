# Usage 手册与 CardBush 加载

`usage` 提供可重复任务的使用手册：教师总结默认计划节点、执行示例、公开理由、替代方向和参数调整方法；用户选择手册后，由当前模型自主执行。加载只兼容 CardBush，直接复用其计划、插件命令和 Hooks，不建设其他 Agent 的适配层。

`update_task_plan` 是唯一进度来源。手册提供默认计划，执行模型决定复用或调整；加载、指导投递和压缩恢复都不会自行推进计划。不要求教师验收或每个节点提交证据。此前一组带/不带 usage 的真实 PPT 试跑，两组都因请求预算耗尽而未完成交付；本次架构验证不代表新增的真实模型效果结论。

## 用户加载与原生计划

教师导出后，用返回的 `package.files` 写成插件目录，连同相对路径素材压成 ZIP，或直接从目录安装。现有插件安装流程负责加载，无需新的管理页面。安装不启用手册；用户使用导出结果中的 `activation` 命令（`/usage-…:use 任务参数`）选择，使用 `deactivation` 命令停用。命令只载入手册，正文中的 shell 示例不会作为动态上下文执行。任务参数保持原文。

顶层 `plan` 是有序节点 ID 数组，最多 20 项；它引用 `nodes`，不保存执行状态。初次加载提供总览和 `plan_template`。执行模型通过 `update_task_plan` 复用或调整，保留仍适用的节点上的 `usage: {usage_id, node_id, definition_sha256}`。节点改名、重排、拆分后仍可保留引用；明确换用其他方法时可以通过原生 patch 的 `usage:null` 解除引用。覆盖已有计划仍受原来的 revision 和 scopeChangeReason 规则约束。

Runtime 每次请求前读取原生计划，提供当前节点指导；新增且未关联的执行节点不会被误认为旧节点。计划引用包含手册内容摘要，替换手册后旧引用不自动指向新内容。压缩与重启后从保存的手册和原生计划恢复，无需模型重新选择节点。完成后停止投递默认节点的执行指导。过长的计划详情可通过 `usage status` 或原生 `update_task_plan(action=get)` 读取，当前节点的指导始终优先保留。

加载时只记录原生计划的 revision 基线，用于区分已有计划与加载后的主动调整，不保存另一份进度。模型完全改用自己的计划后不会被反复要求重新套用模板；用户再次选择同一手册用于新任务时，会重新提供模板，保留上一次已完成的计划供参考。

## Hooks、guard 与 Command

在加载命令 `commands/use.md` 的 frontmatter 中声明 `usage: ./usage.json`，并可附加现有 CardBush `hooks`。这些 Hooks 仅在当前会话选择了该手册时参与执行；不会影响其他会话或子 Agent。`PostToolUse` 匹配 `update_task_plan` 可观察节点更新；`PostToolUseFailure` 可给出恢复指导；会话与压缩事件沿用现有 Hooks。常用操作可作为其他原生 Command 放入 `commands/`，或沿用 `recipes`。

其中 `PreToolUse` 是执行前 guard：限定为同步的 `command` 或 `mcp_tool`，沿用插件设置中的信任机制。必需 guard 尚未被信任时不加载手册。guard 必须明确返回 `allow` 或 `deny`（例如 `hookSpecificOutput.permissionDecision`）；异常、空输出、未知结果和超时都会阻止该次操作。不能把检查失败当成允许。

手册或 Hook 声明变化后，旧挂载停止提供指导；已有必需 guard 的包会暂停相关工具执行，直到用户重新选择或停用。用户选择其他手册或 stop 命令时，旧手册的 scoped Hooks 不得阻止这个选择。用户在插件设置中禁用或卸载整个插件时，其指导和 Hooks 一起退出。其他插件的 Hooks、权限规则继续生效。

停用命令使用 `usage: {file: ./usage.json, action: unload}`。加载/停用命令强制只能由用户调用。模型不能通过 `usage import/enable/disable` 替换所选插件手册；作者独立会话中的原有 JSON 导入、暂存和测试方式保持兼容。

## 教师怎样编写

先调用 `usage({"action":"guide"})` 获取编写方法和明确标注为未验证的起始模板，再加载 `get_tool_schema({"name":"usage"})`。完整结构按需读取，不放进所有会话的固定前缀。

旧包的最小字段保持兼容。新任务手册增加 `plan`，每个计划节点应说明：目标、实际做法与示例、为什么这么做和省略的影响、至少两个替代方向及其适用条件、参数调整方法和完成条件。未实测的方案明确标注。结构检查反馈缺失内容，不强迫每一步验收；schema 仍描述调用输入，不把 Runtime 的默认值误标为必填。

1. **先定义结果好在哪里。** `criteria` 区分 `outcome` 与 `process`。例如阅读顺序、文字可读性属于结果；文件可打开、成功导出属于过程。每条标准写明观察条件、达标迹象和未达标时的修正方法。
2. **制作并观察真实样本。** 用已有工具查看成品，记录失败和修正；不能根据教师的模型名称认定它表现更好。比较前后版本时保留相同内容、需求和检查条件。
3. **采集可追溯引用。** `usage({"action":"capture"})` 返回本会话当前 turn 最近的业务回执定位和指纹；可用 `turn_id`、`tool_call_ids` 指定已知回执。它不复制参数、结果正文或私有推理，不打开图像，不自动提炼轨迹。真实渲染图等由普通工具检查，作为相对路径的 `asset` 或外部 `reference` 加入证据。
4. **写出有节点的手册。** 用 `plan` 排好默认执行节点。节点的 `decisions` 记录适用线索、选择、简短公开理由、至少两个替代方向的取舍，以及参数从什么现场事实推导、何时调整。关联到质量标准。能力用用途、推荐理由、检索词和行为契约表达，不要求固定插件、Skill 或工具名称。稳定操作可封装成 `recipes`，恢复指导可按方法完成回执触发。
5. **区分观察、判断和证据。** 示例的 `assessments` 写明标准、判断、具体观察与 `evidence_ids`；未观察用 `unreviewed`。`comparison` 引用前后证据并写明 `held_constant` 和 `changed`。有反例和修正依据比只记录一次成功调用更有用。
6. **只读检查草稿。** `usage({"action":"review","usage":<定义>})` 检查格式、引用、教学覆盖和本会话回执指纹，提示缺失的判断依据、未检查的结果、写死的实现名称、方法契约等。没有传 `usage` 时检查已保存的定义。它不会安装草稿、运行代码或修改 revision。
7. **保存并安装。** `import(enabled:false)` 暂存教师草稿；`export` 保留原有定义和 `assets_to_package`，并返回 `package.files`：插件清单、`usage.json`、生成的 `usage.md`、use/stop 命令。教师仍只维护原有定义，不重复编写 Markdown。用普通文件工具保存并附上素材，安装到 CardBush 后由用户选择。插件根目录成为当前 `asset_root`，不导出绝对路径、会话状态或权限。学生用当前工具自主执行与自检。

[演示文稿设计草稿](examples/presentation-design-draft.usage.json) 展示如何表达层级、间距、内容保真和参数适配。它刻意没有编造成功评估或截图；检查会提示尚缺真实观察与比较。旧的 [文档修改示例](examples/document-edit.usage.json) 保持兼容，展示不含新字段的基础经验包。

## 能力建议与教师封装

与 Skill、插件配合时，已有 Skill 的详细说明、参考资料和脚本继续从原资源读取，usage 不复制一份手册。usage 用来在执行环节提供适用方法、决策依据、示例和检查提醒，也可封装可复用方法；真实操作继续使用原有内置工具或插件工具。`recommend` 复用现有工具目录的排序与 Skill 搜索入口，没有另建 Skill 目录。Skill 也可以包含判断和质量要求，这些并不是 usage 独占的内容类型。

经验包顶层 `capabilities` 使用包内 ID、`purpose`、`recommendation`、`query` 和可选 `contract`，描述需要什么能力以及预期行为。节点通过 `recommendations` 引用它们。`usage({"action":"recommend","capability_id":"render-pages"})` 从当前可见工具目录给出关键词候选和加载入口，或给出 Skill 的发现入口；不会自动选择第一名、安装插件或授予权限。候选排序是现有关键词检索，不是语义兼容性证明。

教师可以把稳定实现放入 `recipes`：声明业务参数、所需能力 ID 和异步 JavaScript 方法体。方法从 `input` 读取参数，通过 `caps[能力ID](参数)` 调用本地绑定的实现，也可做不依赖工具的计算。代码随包保存，学生无需重新编写。具体实现名称只出现在学生这次调用的 `bindings` 中，不成为可迁移经验的依赖；绑定前检查当前 schema 与行为契约，API 不兼容时选另一实现或调整封装，不能仅因名字相似就调用。

学生先用 `usage({"action":"recipe","recipe_id":"column-regions"})` 读取参数说明，再通过已有 `run_tools` 执行。例如导入示例草稿、revision 为 1 时：

```json
{
  "usage": {
    "recipe_id": "column-regions",
    "expected_revision": 1,
    "parameters": { "width": 960, "height": 540, "margin": 32, "gutter": 24, "columns": 3 },
    "bindings": {}
  }
}
```

这是 `run_tools` 的参数。此例封装区域几何计算，不依赖外部工具。需要文件读写或作者库的方法通过 `requires` 声明能力，学生将对应 ID 绑定到当前发现的工具；读取真实结果的工具仍走普通权限、Hooks、schema 发现和 journal。所有业务输入先校验；缺少绑定、工具不可用或版本不符时不会启动方法。方法内只能调用声明并绑定的能力，不能绕过取消或原工具权限。

封装复用现有 QuickJS 沙箱、后台任务及完成投递，没有另建工作流引擎。代码不能直接访问 Node、文件系统、网络或导入库，需要借助正常工具。长任务返回原有任务句柄。成功、失败、取消和实际副作用继续由原 journal 记录；`recipe_result` 匹配宿主生成且属于当前定义的完成身份，不信任普通工具正文伪造的状态。教学草稿即使 `enabled:false`，教师仍可显式调用方法测试；自动指导保持关闭。

导入与 review 均不运行方法。教师先用 `import`、`enabled:false` 暂存包含方法的草稿，再调用 `recipe` 读取当前 revision 和参数入口，通过 `run_tools` 实际测试、检查结果，用 capture 记录证据，最后 review 和 export。review 提示代码尚未被它执行验证；几何计算正确也不能证明最终 PPT 的视觉质量合格。

`review` 始终返回 `quality_verified:false`。`coverage` 是作者填写的覆盖统计，不是效果分数。`matched_local_receipt` 只证明指纹匹配；跨会话回执不读取，资产与外部引用不打开也不认证。视觉判断只有回执指纹时会提示补充实际渲染依据。工具不能替代教师观察成品，也不能证明能力迁移；这些仍需要独立质量评估和对照实验。

## 作者调试路径

1. 在目标会话调用 `get_tool_schema({"name":"usage"})` 读取完整编写协议。
2. 用 `guide` 的模板或 [演示文稿设计草稿](examples/presentation-design-draft.usage.json) 根据任务编写方法、能力建议、约束和示例。
3. 调用 `usage`，传入 `{"action":"import","expected_revision":0,"usage":<完整定义>}`。导入后默认启用；`enabled:false` 只保存。
4. 使用当前执行模型完成任务。它仍直接使用正常工具，不需要每轮调用 `usage`。
5. `usage({"action":"status"})` 查看选中了哪些指导、匹配原因、真实回执引用以及能力是否可用。

若会话使用冻结的旧工具目录，通过现有 `get_tool_schema` / `call_tool` 发现并调用已加入当前执行范围的 `usage`；新会话的默认目录直接显示它。

## 管理接口

| action | 用途 |
| --- | --- |
| `guide` | 无需先导入，返回教师编写方法和未验证模板。不调用模型，不改变状态。 |
| `capture` | 返回本会话真实回执的定位与 SHA-256；默认当前 turn 最近 6 条业务回执，最多 8 条。也可指定 turn 与调用 ID。不读取其他会话，不复制正文。 |
| `review` | 对传入草稿或已保存定义做只读诊断。无效草稿返回问题路径；检查教学完整性与局部溯源，不认证质量，也不阻止学生执行。 |
| `recommend` | 使用 `capability_id` 读取能力建议并发现当前工具候选或 Skill 发现入口，不自动绑定或执行。 |
| `recipe` | 使用 `recipe_id` 读取教师封装的方法说明、业务参数、依赖与 `run_tools` 调用方式，不执行代码。 |
| `import` | 导入或替换经验包，使用当前 `expected_revision`，首次为 0。可传本地 `asset_root` 定位包内资产；替换时不沿用旧包的目录。重新开始记录适用的回执范围，清除旧 focus。 |
| `status` | 只读查看启用状态、revision、节点、当前指导及选择原因。`installed:false, revision:0` 表示当前会话尚未导入包；`installed:true, enabled:false` 表示包已保存但指导关闭。不会更新任何计划或执行状态。 |
| `export` | 返回完整教学定义、文件名、相对资产引用和 `package.files` 中的 CardBush 插件文件，由现有文件工具保存。不自动复制资产、安装插件、运行代码或导出会话状态与权限。 |
| `focus` | 使用 `expected_revision` 和 `node_id` 选择旧包或尚未关联计划时的基础指导；`node_id:null` 恢复 entry_node。已关联的原生计划始终优先，这不是完成声明。 |
| `enable` / `disable` | 使用 `expected_revision` 开关自动投递。重新启用时不复用禁用期间的旧工具事件。 |

状态按会话隔离，保存于 Runtime 数据目录下的 `usage-guidance`。删除会话同步删除此状态；不会自动复制给子 Agent、其他会话或项目。原型仅支持主 Agent。

## 节点是方法和示例

节点包含 `instruction`、`adaptation`、`checks`、`recommendations`、`recipes`、`decisions` 和 `examples`；共享 `criteria` 描述结果与过程标准，`evidence` 保存证据定位。新字段均可省略，兼容旧 `bush.usage.v1` 定义。旧节点的 `capabilities` 精确工具名形式仅为兼容保留，新编写方式优先使用顶层能力建议。`checks` 是给执行模型的自检方法，没有被伪装成程序已经完成的验收。示例中的工具参数与观察全部是教学数据；路径、UI ID 和结果要从当前环境重新获取。`source` / `constraints.source` 是作者提供的溯源说明，不是 Runtime 的认证。

旧名称式能力由 Runtime 用当前注册表和请求范围核对可用性，review 会提示迁移为能力描述。新建议按当前环境发现实际实现，两种方式均不自动装载 schema、不跳过发现或授权。安装经验包不代表安装其中推荐的能力。

## 自动选择与 loop 投递

每轮正常模型请求前，优先按原生计划引用选择当前节点；尚未关联计划时提供总览和默认计划。无 `plan` 的旧包继续使用 entry_node / focus。原生计划完成后不再投递执行节点；计划中的其他节点不会被结果触发器提前召回。额外的恢复与方法指导可以通过 `when` 在预算内补充：

- `on:task`：对最近一条普通用户消息做大小写无关的字面关键词匹配；本轮压缩移除原文时使用本轮原始请求，新用户输入优先。不用模型推测阶段。
- `on:tool_result`：匹配上次模型请求以来的一批真实工具回执，可按工具名、outcome 和错误码限定。并发操作保留各自结果；同一个工具可能在处理不同文件，后一次成功不会被推断为修复了前一次失败。`returned` 仅表示工具返回；声明的 MCP 错误和终端失败归入 `failed`。
- `on:recipe_result`：按包内方法 ID 和 outcome 匹配真实完成回执，避免依赖底层工具名称。完成身份包含经验包定义摘要；替换定义后到达的旧方法结果不能激活新定义的指导。新包优先使用这种触发或带适用说明的一般结果触发，工具名形式仅为兼容保留。
- 优先级先按 `priority`，再按匹配的具体程度，最后按节点 ID 排序。每条规则内部条件为 AND；多个规则之间为 OR。
- 管理、schema 发现、压缩和成功的普通异步协调回执不替代业务结果批次。教师封装方法的完成回执由宿主携带受校验的身份，可以与内部原生结果一起触发对应指导；不会遮蔽内部失败。协调工具在分派前失败仍可触发修复指导。示例、模型自述、压缩摘要和任意工具正文都不能充当触发事实。

指导以带来源标记的 internal user 消息追加，不改写系统前缀或工具目录。内容未变化时不重复追加；投递游标和当前结果批次独立持久化，不修改经验包版本，status 查询不消费结果。压缩或重启后恢复相同指导，新的业务结果替换旧批次，重新启用不回放禁用期间的动作。禁用后追加一次失效通知。维护任务、Hook 评估和子 Agent 不投递。

经验包最多 24 个节点，每节点 6000 字符，共享约束最多 3000 字符，质量标准最多 5000 字符，证据定位最多 16000 字符，能力建议最多 4000 字符，封装方法最多 6 个、每个代码最多 24000 字符；全包最多 160000 字符，当前指导仍最多 24000 字符。只投递当前节点引用的证据以及能力/方法摘要入口，方法代码不重复进入每轮上下文。多个节点超预算时保留优先节点并列出 `deferred_lessons`。证据过多时保留基础方法、设计决策和标准，列出 `deferred_evidence`，可通过 export 获取完整引用。必要时省略延后节点的名称和重复的能力描述，保留 ID 与调用入口。文件损坏或恢复失败提供可去重的不可用通知，不阻止正常任务；guide、capture 和传入草稿的 review 仍可使用。真实回执由原有 journal 保存。

为做宿主侧 A/B 实验，可设置请求 metadata 的 `usageGuidanceEnabled:false` 临时关闭指导投递，不修改保存的经验包，也不会关闭已选手册的 guard。模型工具集合保持相同。

## 验证与下一阶段

构建协议、Runtime 和 Electron 后运行 `node --test packages/bush-runtime/test/usageGuidance.test.mjs packages/bush-runtime/test/usageRecipes.test.mjs scripts/test-usage-plugin.mjs`。覆盖真实文件操作、不同名称的工具绑定、原生计划更新、压缩/重启恢复、导出后安装、用户选择、guard 副作用前拦截、异常输出、停用和来源变化。脚本化 provider 验证宿主行为，不代表新增真实模型效果评估。

下一阶段需要固定未参与经验编写的任务、工具环境和预算，对比关闭指导、开头一次性示例、loop 自动示例。记录产物正确性、失败恢复、用户介入、耗时与总 token；教学成本单独记账。当前没有语义检索、自动提炼轨迹、通用阶段识别或跨模型效果结论。
