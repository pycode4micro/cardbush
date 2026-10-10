---
name: 订单核验
team:
  id: order-review
  description: 库存与订单并行核实，再汇总结果
  max_parallel: 2
---

# 订单核验

## 为什么这样协作

库存与订单来自不同来源，分别检查可避免仅凭单方信息下结论。汇总时保留依据和缺失项，随后交付结果。

## notes
```md-node
name: 讨论与备忘
```

这一节是普通文档，不参与执行。需要核验的内容分别记录在 [[#stock|库存查询]] 与 [[#order|订单核对]]。

## stock
```md-node
name: 库存查询
agent_id: warehouse
depends_on: []
position:
  x: 80
  y: 100
```

根据用户提供的订单查询库存，返回数量、来源和缺失信息。

## order
```md-node
name: 订单核对
agent_id: reviewer
depends_on: []
position:
  x: 80
  y: 280
```

核对订单信息是否齐全，列出需要澄清的字段，不修改订单。

## report
```md-node
name: 汇总回复
agent_id: reviewer
depends_on: [stock, order]
position:
  x: 400
  y: 190
```

结合上游库存和订单结果，交付简短结论、依据与待确认事项。
