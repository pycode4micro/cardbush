# CardBush appearance style configuration

CardBush can import a small, declarative JSON palette from **Settings → Personalization → Appearance**. Imported files do not execute CSS or JavaScript; they only override an allowlisted set of theme colors.

可直接复制并修改仓库中的 [`cardbush-theme-example.json`](examples/cardbush-theme-example.json)，再从 **设置 → 个性化 → 外观** 导入。导入只读取受控颜色字段，不执行 CSS 或 JavaScript。

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

`base` accepts `light`, `dark`, or `parchment`. Every color field is optional, but at least one must be present. Supported values are hex, `rgb()`/`rgba()`, or `hsl()`/`hsla()` colors. Unknown keys and executable CSS constructs are rejected.

The parsed palette is copied into local settings, so the original JSON file does not need to remain in place. Importing another file replaces the previous imported theme.
