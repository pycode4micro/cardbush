# 内置显示日历

[English](README.md) · [简体中文](README.zh-CN.md)

两份离线 JSON 覆盖 2020–2050，默认关闭。启用中国日历同时显示农历日期。日历数据不会创建日程、提醒或自动化任务。

- china.json：根据香港天文台[公农历对照表](https://www.hko.gov.hk/en/gts/time/conversion.htm)生成农历节日和清明，包含常见传统及固定公历节日，不包含中国每年的放假调休和补班。
- us.json：根据 [OPM 规则](https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/)列出全国联邦节日及标准周一至周五工作的周六/周五、周日/周一补休。Juneteenth 从 2021 年开始；不含区域性就职日、州节日或临时行政命令休假。

维护时显式运行 `node scripts/build-bundled-calendars.mjs`，只有再生成需要联网。未来规则和源数据可能变化；这只是显示日历，不能用于工资或休假权益计算。
