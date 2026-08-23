# 工具图片产物：后端 SSE 与历史持久化对照清单

前端已经接入结构化工具媒体产物。推荐后端直接扩展现有聊天流中的 `event: tool`，不新增并行图片事件，也不要求前端解析 LLM 正文来判断工具状态。

## 1. 协议目标

同一个图片产物需要贯穿以下三条链路：

1. 工具运行期间通过 `POST /v1/chat/stream` 的 `event: tool` 实时提供“查看图像”入口；
2. 会话历史中的 `tool_executions[].artifacts` 可以恢复该图片；
3. 需要出现在终轮答案中的图片，同时写入最终 `assistant_message.attachments`。

前端不会根据 `inject_image` 这一单一工具名做判断。`inject_image`、`inject_image_input`、浏览器截图、图像生成和其他返回图片的工具都使用同一份 `artifacts` 结构。

## 2. SSE 推荐格式

继续复用现有事件：

```text
event: tool
data: { ... }
```

工具开始时可以暂时没有产物：

```json
{
  "id": "call_xxx",
  "tool_call_id": "call_xxx",
  "name": "inject_image",
  "state": "running",
  "turn_id": "turn_xxx",
  "assistant_message_id": "message_xxx",
  "assistant_segment_index": 1,
  "artifacts": []
}
```

图片可用后，使用相同 `tool_call_id` 再发送一次 `tool` 事件：

```json
{
  "id": "call_xxx",
  "tool_call_id": "call_xxx",
  "name": "inject_image",
  "state": "completed",
  "success": true,
  "turn_id": "turn_xxx",
  "assistant_message_id": "message_xxx",
  "assistant_segment_index": 1,
  "artifacts": [
    {
      "id": "artifact_xxx",
      "kind": "image",
      "path": "C:\\workspace\\images\\result.png",
      "name": "result.png",
      "mime_type": "image/png",
      "size": 142133,
      "display": "attachment",
      "read_only": true
    }
  ]
}
```

前端以工具 `id/tool_call_id` 合并工具状态，并以规范化路径合并增量产物。因此后端可以发送完整产物快照，也可以在同一工具的后续事件中追加产物；不要为同一工具产物生成新的工具调用 ID。

## 3. 必填和推荐字段

| 字段 | 级别 | 说明 |
|---|---:|---|
| `id` 或 `tool_call_id` | 必填 | 同一次工具执行的稳定 ID |
| `name` | 必填 | 工具名称，不用于判断是否为图片工具 |
| `state` | 必填 | `running/completed/failed/cancelled` 等既有状态 |
| `turn_id` | 必填 | 防止跨 turn 串流 |
| `assistant_message_id` | 必填 | 把图片放进正确 assistant 气泡 |
| `assistant_segment_index` | 必填 | 引导、多 round 和 loop 中的分段归属 |
| `artifacts[].id` | 推荐 | 稳定产物 ID，便于审计和后续操作 |
| `artifacts[].kind` | 必填 | 图片使用 `image` |
| `artifacts[].path` | 必填 | 本机后端返回规范化绝对路径；远端后端应返回受鉴权 URL |
| `artifacts[].name` | 推荐 | 展示文件名 |
| `artifacts[].mime_type` | 推荐 | 如 `image/png` |
| `artifacts[].size` | 推荐 | 字节数 |
| `artifacts[].display` | 推荐 | 工具产物使用 `attachment`；前端只显示“查看图像”，点击后才加载完整图片 |
| `artifacts[].read_only` | 推荐 | 当前固定为 `true` |

不要把大体积 base64 放进 SSE。桌面同机模式优先返回绝对路径；远端模式返回短期、受鉴权的下载/预览 URL。

## 4. 历史恢复

会话历史接口返回的工具执行对象必须保留与 SSE 相同的字段：

```json
{
  "tool_executions": [
    {
      "id": "call_xxx",
      "turn_id": "turn_xxx",
      "assistant_message_id": "message_xxx",
      "assistant_segment_index": 1,
      "state": "completed",
      "artifacts": [
        {
          "id": "artifact_xxx",
          "kind": "image",
          "path": "C:\\workspace\\images\\result.png",
          "mime_type": "image/png",
          "display": "inline",
          "read_only": true
        }
      ]
    }
  ]
}
```

必须在发送终态 `done` 前完成工具产物和消息分段的持久化。重连后不依赖前端内存事件重放。

## 5. 终轮答案

终轮真正希望用户看到的图片应写入最终 assistant 消息附件，而不是让 LLM 把路径拼进自然语言：

```json
{
  "assistant_message": {
    "id": "message_final",
    "content": "图片已经准备完成。",
    "attachments": [
      {
        "id": "artifact_xxx",
        "type": "image",
        "path": "C:\\workspace\\images\\result.png",
        "name": "result.png",
        "size": 142133
      }
    ]
  }
}
```

前端仍兼容“单独一行的绝对图片路径”和旧工具输出中的独立图片路径，但这只是迁移兜底，不应作为正式协议。

## 6. 安全与失败语义

- 后端在发出产物前验证文件存在、是普通文件且 MIME/文件头确实为受支持图片。
- 只暴露当前 workspace、任务目录或已经获得授权的路径。
- 工具失败但已产生有效图片时可以保留 `artifacts`，同时将工具 `state` 标记为 `failed`。
- 路径失效时历史记录仍保留产物元数据，前端展示“图片无法预览”，不能让整个消息渲染失败。
- 不在 `output` 中混入访问令牌、鉴权 URL 查询参数或其他敏感信息。

## 7. 后端验收矩阵

1. `running tool -> artifact update -> completed`：工具结束前出现“查看图像”，点击后才加载完整图片，且不闪烁、不重复。
2. 同一工具连续产生三张图片：三个产物都保留，重复事件不重复展示。
3. 引导产生 segment 2：图片只显示在 segment 2，不迁移到最后一个气泡。
4. SSE 断线后刷新：历史恢复出的图片、工具状态和分段位置一致。
5. 最终答案选择一张工具图片：终轮附件只显示一次。
6. Stop/崩溃恢复：已经持久化的产物继续保留，未完成工具进入权威终态。
7. 非图片工具输出 `.js/.txt` 路径：不得被误识别为图片。
8. 失效路径、超大图片和伪造扩展名：返回明确失败，不影响其余 SSE 事件。
