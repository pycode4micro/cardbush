# CardBush Browser Use

[English](README.md) · [简体中文](README.zh-CN.md)

Manifest V3 扩展通过鉴权 loopback WebSocket，把 Windows 10/11 的 Chrome、Edge 配置连接到 CardBush Broker；API 最低声明 Chromium 116。默认本地 App 与 CLI 共用 broker/连接，拥有进程退出后由存活客户端接管，不重放中断命令或启动替代浏览器配置。

## 开发安装

1. 在 Windows 启动 App 或本地 CLI，安装并启用 Browser Use。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式，选择“加载已解压的扩展程序”。
3. 选择本目录，在 CardBush 风格的扩展窗口中确认一次首次连接，无系统弹窗或配对码。网页访问另行授权。开始任务后，新标签放在以会话命名的青色组内，连接器只能列举和控制该会话组内标签。
4. 需要个人现有标签时，在扩展面板明确复制到活动 CardBush 组，原标签不变。

Agent 新建标签默认在后台；选择操作目标不切换用户当前标签。只有明确 `background:false` 或 `bringToFront:true` 才前台创建/聚焦。升级后重新加载现有扩展，不卸载（卸载会清除状态）。当前版本以 `manifest.json` 为准。

## 连接、身份与恢复

保存端口被占用或被 Windows 拒绝时，App 先尝试原地址，再在默认动态客户端端口段以下的 32 个分散候选中有限尝试。扩展先原地址，再最多 4 个并发、有截止时间的握手寻找同一配对 broker；只有双方鉴权成功才保存新地址，配对、路由及网站授权不变。失败沿用有限重连，禁用取消发现。

1.4 起自动发现已启用本机连接器，仅在 CardBush 风格扩展窗口确认一次，无 Native Messaging 权限/注册表注册。现有配对继续鉴权 WebSocket 重连，无需弹窗。`list_browsers/select_browser` 向模型提供已连接配置；默认只作用于未绑定会话，已有绑定跨 broker 重启保留。显式切换先释放旧范围，失败/断线不回退其他浏览器。名称用于说明目标，配对凭据和准确 Origin 才用于鉴权。

启用插件启动连接器；新扩展可自动申请，明确禁用保持禁用。仅启用的本机 broker 提供注册并在提交凭据前复查。监听器验证 loopback、Host、精确扩展 Origin，有限 ECDH 握手把 offer/accept 绑定到请求。唯一确认窗口由浏览器扩展持有，worker 核对扩展 ID、准确页面、标签、请求 token 及有效期；伪造“已同意”不能绕过。Origin 不能单独认证本机进程，首次信任依赖用户明确同意，之后固定双方身份。确认前不可访问/控制浏览器。

拒绝跨重启保留，需明确重新申请；同时只允许一个窗口，并有持久冷却限制。取消/断线中止弹窗。配对协议 v2 替代旧双弹窗，App/CLI 与扩展一起升级；已有 CB2 配对保持可用。

远程 worker 保留手动配对，不在服务器弹窗，也不继承桌面连接。在目标 worker 机器运行本地 CLI，使用 `/browser pair chrome` 或 `/browser pair edge`，保持 CLI 打开，将代码直接粘贴到目标扩展。桌面设置也可生成本地手动码。不要把码发给模型；`/browser status` 查询不生成码。5 分钟限制是新码接受期，不是现有连接寿命。

已保存的连接在 3 次快速尝试后，继续通过一次性 30 秒 alarm 鉴权重连；worker/浏览器重启及旧版本暂停状态升级后仍可恢复。后台恢复不会发起新注册或再次弹出授权窗口。首次注册仍在 3 次失败后暂停，打开面板不重置这个限制。点击连接显式重试当前目标（含待完成本机注册），不回退旧配对、不重放操作。临时断线无需新码或重新授权。释放 debugger 不再等待无响应的页面命令，避免断线清理卡住后续重连或用户主动申请的授权弹窗。

暂时禁用桌面连接器停止监听/控制，保留配对及绑定，再启用可自动重连。扩展明确禁用也保留配对，直到点击连接。移除一个连接仅撤销它；移除连接器配置撤销全部凭据；共享本机 broker 保留无效路由以防旧会话误用其他浏览器，旧独立连接器则清理 routes 文件。普通退出保留启用意图和数据。主动重新配对同一配置后可移除旧离线项；撤销后明确连接会创建新配置身份，后台重试不能撤销“撤销”。

## 页面访问与生命周期

turn 结束挂起 debugger 并折叠管理组，但保留会话标签授权。待授权在面板保留 5 分钟，可在模型 turn 结束后完成；多个会话同时等待时，必须明确选择目标。临时授权存 `chrome.storage.session`，站点/全部站点授权为可撤销持久设置。

持久网站授权跨正常重启/临时禁用保留，扩展“撤销访问”清除。授权只覆盖管理组，不隐含个人标签。一次性授权、标签/组 ID 属浏览器会话状态，重启不根据标题/数字 ID 接管恢复的个人标签。新连接不清除其他凭据。

## 图像与下载

用 `take_screenshot/resize_page/export_image` 验证视觉。非明确指定的小于 320×180 CSS 像素视口在截取前修复；显式尺寸保留。`fullPage` 按文档边界，`selector` 截取元素；释放/挂起 debugger 清除视口模拟。`export_image` 导出 canvas 或捕获 SVG/HTML；`evaluate_script` 的显式图像值（含 JSON 字符串 `{url:dataURL}`）也自动附图，确需原 JSON 时才 `resultType:"json"`。视觉检查无需浏览器下载。原图按会话保存到 browser-connector artifact 目录，Runtime 另生成有预算的视觉副本。

`downloads` 权限支持 `download_file` 在 `Downloads/CardBush/<task-id>/` 创建 `saveAs:false` 任务；`download_status/cancel_download` 跟踪/取消。重复请求复用任务（即使 Chrome 尚未确认开始），只有 Chrome `complete` 才提升为正式产物，`.tmp` 不算完成。中断/取消不自动重试，任务归属和请求键在 `chrome.storage.session` 跨 worker 重启，不追踪无关下载。

## 分发、MSIX 与迁移

生产应发布经审查的 Chrome Web Store/Edge Add-ons 扩展。首次上传后将商店公钥写入 `manifest.json`，核对派生 ID 与 `chromeConnectorExtensionId`；不同则更新常量及精确 Origin 检查后再发桌面包。`CARDBUSH_CHROME_CONNECTOR_STORE_URL` 指向最终商店页，代替 unpacked 目录。

MSIX 配置在 LocalState；旧 Native Messaging 注册通过归属校验迁移，出现旧注册提示时按设置页处理。单一扩展确认不提权、不请求 UAC，关闭/拒绝/超时均拒绝。MSIX 保持注册表/文件虚拟化，不声明 `unvirtualizedResources` 或执行别名。网站授权与连接同意始终分离。实现与许可见 [第三方说明](../THIRD_PARTY_NOTICES.md)。
