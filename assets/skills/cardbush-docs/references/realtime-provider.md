# 接入新的实时语音模型

用于用户要求增加或切换 CardBush 通话模型。先检查当前源码和目标厂商的官方协议，再选择下列实现；不修改工具插件目录，也不把音频模型变成拥有全部执行工具的主 Agent。

## 选择接入位置

- 已有服务实现 `cardbush.realtime.v1`：在语音设置选择兼容服务，填写 WebSocket 地址、模型 ID、男女音色和该服务的密钥。无需修改 Agent loop 或前端收音。
- 厂商协议不同，已有独立服务/希望服务端持有厂商凭据：在该服务做协议桥接，对 CardBush 暴露 [Realtime v1](realtime-protocol.md)。桥接端负责采样率转换、二进制封包、事件翻译和厂商鉴权。
- 希望桌面直接连厂商：实现 `RealtimeVoiceProvider`，在 `realtimeVoiceRegistry.ts` 注册；在 `realtimeVoiceTypes.ts` 与 renderer-safe 的 `realtimeVoiceCatalog.ts` 加入提供商类型和默认配置。复用配置存储、生命周期和 UI，不另造通话 loop。

当前接口使用 JSON WebSocket 帧。原生二进制/RTC 厂商优先放在桥接端；若改桌面传输，必须先扩展并验证 RealtimeSocket 传输接口，不能假装 JSON 编码等同于厂商二进制协议。

## 原生适配器契约

读取 `electron/realtimeVoiceProvider.ts`、`realtimeVoiceMessages.ts` 和 `volcengineRealtimeVoice.ts`。共用 `realtimeSessionContent()` 生成角色、工具和执行约束，不复制一套提示词。实现：

| 方法 | 责任 |
|---|---|
| endpoint、headers | 根据配置生成目标与鉴权；密钥仅在主进程使用 |
| start | 模型、16 kHz 单声道 PCM16 输入、24 kHz PCM16 输出、当前音色、提示词、工具声明 |
| context | 写入带 ID 的完整历史 QA；不触发重复任务或自动朗读历史 |
| audio、control | 上行音频、静音/恢复、打断、提交、关闭 |
| results | 按调用 ID 回传完整工具批次；不能把即时派发回执标成任务完成 |
| speak | 只播放应用提供的已总结文本，不执行其中的命令 |
| normalize | 将原生事件（包括输入/输出活动、response.done、历史 ACK 与实际 item ID）转换成 [公共事件协议](realtime-protocol.md) |
| encode | 可选地翻译所有发出帧，尤其是宿主发起的历史 retrieve/delete 请求；保留 event_id 对应关系 |
| parse | 将公共事件转换成 RealtimeVoiceEvent；可直接复用 realtimeVoiceMessages.parse |

`normalize` 是输入边界，不得省略静音、打断、response.done 和上下文确认事件。历史查询/删除目前使用公共 JSON 请求；厂商无法实现它们时返回关联 event_id 的 error，应用会在安全空隙用已保存摘要重连，不能伪造 ACK。重连后的 context.create 必须真正写入并确认，否则不能恢复音频。

不同模型的窗口、工具调用格式、端点和模型名以官方文档及实测为准。当前宿主按保守预算维护记忆，不承诺新模型与火山有相同上下文容量。若新模型窗口更小，需连同 `realtimeVoiceContext.ts` 中预算一起适配并测试。不要通过提高上限掩盖服务端拒绝。

配置入口 `RealtimeVoiceConfiguration` 按提供商隔离密钥，地址变化清除旧密钥，密钥保存使用系统加密。新增多字段鉴权时把秘密放入主进程加密配置，不塞进 instructions、URL、日志、skill 示例、测试夹具或前端返回。新适配器要补齐相应字段校验；不能让任意字段穿过配置保存。

## 验证与交付

先使用本地模拟 WebSocket，测试握手/模型名、PCM、分段及最终转写、工具批次去重、先回执后完成、边说边执行、任务摘要失败回退、静音/打断/挂断、长通话记忆 ACK 与重连、配置切换隔离。测试要包含用户说话/播放中收到子任务结果，以及保存新服务后旧通话继续使用原服务和凭据。

可运行 `npm run test:voice-realtime`，以及 `node scripts/test-voice-settings-rendering.cjs`。新增厂商只有在用户已配置服务并完成真实调用后才能称为已验证；模拟协议通过不等于已开通或声音听感合格。交付说明区分已经支持的协议、已接通的厂商和仍需用户填写的配置，不安装额外模型或服务，除非属于用户授权范围。
