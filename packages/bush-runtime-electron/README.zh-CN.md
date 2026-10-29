# Bush Runtime Electron 传输

[English](README.md) · [简体中文](README.zh-CN.md)

此包拥有 Electron Runtime Host 的 renderer 侧传输，实现产品客户端消费的 RuntimeTransport 结构边界，不将事件投影为 React 状态。

通信仅使用 bush.runtime_ipc.v1。事件、终态判断、重试、权限和持久化属于 Utility Process Runtime；preload 只转发经验证的命令和事件流信封。

协议不兼容通过 bush.runtime_error.v1 的 protocol_version_mismatch 错误码暴露，不转换为泛化的网络错误。
