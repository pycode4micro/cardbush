# 日历转换协议：cardbush.calendar.v1

## 用途与入口

“定时与自动化 → 日历”提供日、月、年视图。搜索任务名称/提示词、日历名称、条目标题/说明，或输入 `YYYY`、`YYYY-MM`、`YYYY-MM-DD`，只展示匹配的日期。选择某一天查看完整安排。

点击年月标题或「今天」可打开范围选择器，输入年份并选择某日、某月或某年；弹层底部可回到今天。选择时保留当前搜索条件，没有匹配安排的范围会提示。

“日历数据”可切换中国农历、导入 UTF-8 JSON / ICS、停用或移除已导入日历。日历资料仅用于显示，不生成闹钟，也不向 agent 注入指令。实际执行任务见 [定时与自动化](automations.md)。移除导入数据不会删除源文件或自动化任务。

模型的职责是把原资料转换为下面的日期明细文件，提供文件路径供用户导入。当前没有模型日历写入工具；不要发明工具名或热改用户目录里的日历存储。

## JSON 文件

```json
{
  "protocol": "cardbush.calendar.v1",
  "id": "example-anniversaries",
  "name": "纪念日",
  "source": "用户提供的日期清单",
  "timeZone": "Asia/Shanghai",
  "entries": [
    { "id": "anniversary-2026", "date": "2026-09-25", "title": "家庭纪念日", "kind": "note" },
    { "id": "exhibition-2026", "date": "2026-10-10", "endDate": "2026-10-13", "title": "展览", "kind": "event", "description": "10日至12日" }
  ]
}
```

可复制 [完整示例](../assets/calendar-example.json)。顶层及条目不接受未定义字段。

| 字段 | 约束 |
|---|---|
| protocol | 固定为 `cardbush.calendar.v1` |
| id | 1–80 字符；字母、数字开头，后续允许字母、数字、点、下划线、短横线。用于识别同一个数据集 |
| name | 1–120 字符 |
| source | 可选，最多 2000 字符，保留来源/链接说明；不会自动获取远程内容 |
| timeZone | 有效 IANA 时区，默认 `Asia/Shanghai` |
| entries | 1–50,000 条；每条 id 唯一，1–256 字符 |
| entries[].date | `YYYY-MM-DD`，1900–2199 年真实的公历日期 |
| entries[].endDate | 可选，严格晚于 date，**结束日不包含**，同样限定 1900–2199 年 |
| entries[].title | 1–160 字符 |
| entries[].description | 可选，最多 2000 字符，纯文本 |
| entries[].time | 可选，24 小时制 `HH:mm`；省略为全天；这是显示时间，不触发执行 |
| entries[].kind | `event`（默认）、`holiday`、`workday`、`note` |
| recurrenceWindow | 可选，`{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`，from < to、to 不包含，记录已展开的重复日期范围 |

JSON 日期和时间是所属 timeZone 的民用日期明细，界面按记录显示，不再转换一天或推断重复规则。农历、其他历法、无限 RRULE 均应先转换成有限公历明细。保持数据集 id 稳定，重导同一 id 会整体替换旧明细，并保留启用状态；不使用新随机 id 制造重复数据。

单文件上限 8 MiB；最多保存 30 个数据集，总条目上限 50,000、存储上限 16 MiB。解析在独立 Worker 中进行，5 秒超时，堆内存有上限；校验失败不会写入部分数据。

## ICS 导入

支持 `VCALENDAR/VEVENT` 的日期、时区、跨日、`RRULE`、`RDATE`、`EXDATE` 和 `RECURRENCE-ID` 例外。带时间的事件转换为导入设备当前时区，全天日期保持民用日期。优先使用 `VTIMEZONE`，缺失时使用 IANA `TZID`，浮动时间使用 `X-WR-TIMEZONE` 或设备时区。无法识别时区时明确失败，需先转换。

重复事件展开为导入年份的前一年 1 月 1 日至后三年 1 月 1 日（结束日不含）。例如 2026 年导入时为 `[2025-01-01, 2029-01-01)`。界面显示这个范围；它不是永久订阅，到期应重新导入。普通单次事件保留自身日期，不受这个展开窗口限制。

每个主事件必须有唯一 UID；取消的事件不展示。跨时区的重复事件必须包含 VTIMEZONE，否则需先转换为 JSON 明细，避免错误计算持续时间。无主事件的例外、非公历 CALSCALE、过量展开或无可显示条目会失败。`VALARM`、附件和外部 URL 不执行、不下载。需要中国调休、法定假日或其他特殊历法时，优先整理为 JSON 明细，保留可信来源；农历节日不等于法定放假日期。

## 中国农历转换

内置显示通过 JavaScript Intl 的 Chinese Calendar 完成；不推断法定节假日、调休或节气。渲染和转换脚本使用同一实现。以本 Skill 路径为根运行：

```powershell
node scripts/convert-date.mjs gregorian 2026-09-25
node scripts/convert-date.mjs chinese 2026 8 15
node scripts/convert-date.mjs chinese 2025 6 1 --leap
```

返回 `gregorian` 和 `chinese` 对象。农历的 year 是春节所在公历年；month 为 1–12；闰月必须显式使用 `--leap`，普通六月与闰六月是两组日期。正向转换支持公历 1900–2199 年；逆向支持农历 1900–2198 年。日期不存在时脚本报错，不自动挪到临近日期。

年度农历纪念日：逐年调用逆向转换、以实际公历日期生成唯一条目。某年没有指定闰月时，报告缺失，按用户要求决定是否跳过或改用普通月，不能自行猜测。导出后抽查新年、闰月及跨年边界再交付。
