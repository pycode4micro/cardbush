# 商品图库

按聚水潭商品简称（原厂编码/货号）精确查图，提供 `lookup_product_images` 和
`get_product_image`。取图通过已认证的 HTTP 查询直接返回 MCP 图片；无需访问
服务电脑的盘符，不接收任意文件路径或 URL，不进行近似款替换。

EXE 发行包包含运行时。安装后由管理员将连接文件放到
`%LOCALAPPDATA%\CardBushPluginConnections\zjfs-product-image-gallery.json`：

```json
{
  "url": "http://服务电脑的实际局域网IP:18765/mcp/zjfs-product-image-gallery",
  "token": "管理员单独分配的至少32字符访问令牌"
}
```

地址不能填 `0.0.0.0`；这是服务监听地址。令牌不写入插件源码，不发到聊天或仓库。
插件可以离线列出工具；实际查询需要服务电脑在线且该图库路由已启用。
批量查询最多 20 个货号，单次取一张图片，图片最大 4 MiB，仅支持 JPEG/PNG/WebP。
每个货号对应图库里的一张当前图片，不代表该商品全部颜色图或详情图。
