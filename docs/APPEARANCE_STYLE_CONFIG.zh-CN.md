# CardBush 外观样式配置

[English](APPEARANCE_STYLE_CONFIG.md) · [简体中文](APPEARANCE_STYLE_CONFIG.zh-CN.md)

在**设置 → 个性化 → 外观**导入声明式 JSON 配色。导入文件仅覆盖允许的主题颜色，不执行 CSS 或 JavaScript。可以复制仓库中的 [cardbush-theme-example.json](examples/cardbush-theme-example.json) 后修改。

```json
{
  "protocol": "cardbush.appearance_style.v1",
  "name": "Ocean Night",
  "base": "dark",
  "colors": {
    "background": "#0b1220",
    "surface": "#111a2b",
    "surfaceStrong": "#18243a",
    "surfaceRaised": "#20304a",
    "border": "#2d4264",
    "accent": "#65d7ff",
    "accentSoft": "rgba(101, 215, 255, 0.16)",
    "text": "#edf7ff",
    "textMuted": "#b2c5d6",
    "textSoft": "#7890a6",
    "userBubble": "#1a2a43",
    "terminalBackground": "#07101d",
    "danger": "#ff6b7a"
  }
}
```

`base` 接受 `light` 或 `dark`。每个颜色字段可选，但至少提供一个；支持十六进制、`rgb()` / `rgba()`、`hsl()` / `hsla()`。未知字段和可执行的 CSS 构造会被拒绝。

解析后的配色复制进本机设置，原 JSON 不必保留在原位置。再次导入会替换上一份导入主题。
