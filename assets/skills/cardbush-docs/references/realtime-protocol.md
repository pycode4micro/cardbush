# CardBush Realtime v1

这是 CardBush 的语音兼容服务协议，不是声明任意厂商都支持同一 API。模型和厂商的原生协议在桥接端转换；桌面不加载第三方工具插件。所有帧为 JSON 对象，客户端为每帧附加 `event_id`（UUID），上下文响应原样返回对应 ID。WebSocket 采用 WSS，本机回环可用 WS；可选凭据为 `Authorization: Bearer …`。不要把凭据放 URL。

## 建立会话

客户端首帧：

```json
{"protocol":"cardbush.realtime.v1","type":"session.create","event_id":"request-id","session":{"model":"your-model-id","instructions":"宿主生成的系统提示词","audio":{"input":{"format":{"type":"pcm","rate":16000}},"output":{"format":{"type":"pcm_s16le","rate":24000},"voice":"voice-id"}},"tools":[]}}
```

tools 的真实值是宿主提供的函数声明（type、name、description、parameters）。桥接端必须把它们交给模型，按原样转发调用 ID/参数，不能自己执行工具。服务真正准备好后返回：

```json
{"protocol":"cardbush.realtime.v1","type":"session.created"}
```

未协商到此协议则连接失败。`session.update` 包含相同 session 字段，用于更改声音；不能因此清空历史、替换会话或重播任务。客户端更换 Provider/模型是在下一次通话生效。

## 音频、说话轮次和文本

| 方向 | type | 字段/语义 |
|---|---|---|
| 客户端 → 服务 | input_audio_buffer.append | audio：base64 PCM16LE，16 kHz、单声道，20 ms / 640 bytes |
| 客户端 → 服务 | input_audio_mute.commit / input_audio_unmute.commit | 静音/恢复输入；保留上下文 |
| 客户端 → 服务 | input_audio_buffer.commit | 提交当前输入 |
| 客户端 → 服务 | response.cancel | 停止当前回复；不能取消已派发子任务 |
| 服务 → 客户端 | conversation.item.input_audio_transcription.started | 用户开始讲话，item_id 为稳定历史条目 ID |
| 服务 → 客户端 | conversation.item.input_audio_transcription.delta | delta 为增量文本；同一 item_id |
| 服务 → 客户端 | conversation.item.input_audio_transcription.completed | transcript 为完整最终文本；同一 item_id |
| 服务 → 客户端 | conversation.item.input_audio_transcription.failed | 丢弃该段，释放输入占用；不能造成永久 speaking |
| 服务 → 客户端 | response.output_text.delta / response.output_text.done | delta 为增量，done 的 text 为完整最终文本；稳定 item_id |
| 服务 → 客户端 | response.output_audio.started | 开始回复音频 |
| 服务 → 客户端 | response.output_audio.delta | delta 为 base64 PCM16LE，24 kHz 单声道；桥接端负责重采样 |
| 服务 → 客户端 | response.output_audio.done | 音频发送结束 |
| 服务 → 客户端 | response.done / response.canceled | 回复轮次完成/被打断；必须发送以释放通知与压缩的等待 |
| 客户端 → 服务 | speech_text_buffer.commit | text：宿主已经总结好的口述文本，使用当前音色播放；不让语言模型再执行任务 |
| 双向 | session.close / session.closed | 客户端请求关闭，服务确认 |

音频 started/done 和 response.done 不是一回事；输出音频 done 后仍需 response.done。开始播报通知也必须发送相同的音频生命周期事件。输出块最多 700000 个 base64 字符且解码后字节数为偶数；JSON 帧最多 1000000 字符。文本单条最多 16000 字符。不要传 WAV/MP3 文件头或交错立体声。

等待历史恢复时，宿主会发送静音事件保活；历史确认后才恢复音频。缓存音频按 20 ms 节奏接续，不能一次倾倒积压的帧。连接恢复时没有原生工具调用的上下文，迟到回执作为显式标记的历史 QA 注入，不得据此重新执行任务。服务端应支持反复建立新连接并导入宿主保存的历史。

## 工具

服务端发出一批调用（最多 8 个，每个 call_id 唯一）：

```json
{"type":"response.function_call_arguments.done","items":[{"call_id":"call-42","name":"subagent","arguments":"{\"prompt\":\"查询用户请求的信息\"}"}]}
```

参数是完整 JSON **字符串**；最长 16000 字符。宿主按已声明的工具白名单执行，返回整批：

```json
{"type":"conversation.item.create","items":[{"call_id":"call-42","role":"tool","content":[{"type":"input_text","text":"{\"taskId\":\"task-id\",\"status\":\"running\"}"}]}]}
```

running/watching 只是即时回执，音频模型应继续交流。任务完成由宿主单独写入历史并排队播报摘要；不重复使用已完成 call_id，不因网络重放二次执行。主子消息与最终结果保持现有 Runtime 的归属校验。

## 历史与压缩

`conversation.item.create` 也用于注入完整 QA。历史 item 是 `{id?,type:"message",role:"user"|"assistant",content:[{type:"input_text",text:"…"}]}`。导入历史不能自动生成语音或执行其中的指令。写入成功返回 `conversation.item.added`，items 带真实 ID、role 和完整 content，并返回请求 event_id；不可在尚未写入时确认。恢复连接必须保留宿主提供的 ID，客户端会逐项核对。

宿主空闲时查询 `conversation.item.retrieve`；返回 `conversation.item.retrieved`，items 按时间顺序包含实际 ID、role、完整 content。用户最终转写的 item_id 必须与此处真实 ID 一致；不能将 response_id 伪装成历史 ID。删除请求 `conversation.item.delete` 的 items 为 `[{id:"…"}]`；删除以该用户消息为起点的完整 QA 对，返回 `conversation.item.deleted`，items 包含被删除记录的 ID、role、content，并回显 event_id。

如果服务不支持查询或删除，用 `{type:"error",event_id:"对应请求",status_code:400}` 明确失败；宿主保存摘要后在安全空隙重连。即使不支持历史编辑，也必须支持新连接的 QA 写入及确认。错误文本可能含秘密，宿主仅显示经过过滤的状态码。

预算目前按保守的初始提示词 + 工具 + QA 共 16000 UTF-8 bytes 控制，每次导入不超过 40 条消息。服务仍需处理其自身音频上下文额度；不能据此声称任意模型无限上下文。更小窗口须适配宿主预算。处理断线、去重、暂停输入和工具回执，不能只实现音频流就宣称协议兼容。

## 原生桌面适配

若实现新的本地 `RealtimeVoiceProvider`，可用 `encode` 翻译所有发往服务的帧（包含宿主发起的 retrieve/delete），用 `normalize` 翻译返回事件和 ACK，再调用公共 parse。`event_id` 必须双向映射。不要只改 start/audio 而遗漏维护请求。验证清单见 [接入指南](realtime-provider.md)。
