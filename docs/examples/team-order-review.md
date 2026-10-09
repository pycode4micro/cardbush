---
id: order-review
name: 订单核验
max_parallel: 2
---

库存与订单信息并行检查，随后汇总交付结果。

## stock
```md-node
name: 库存查询
agent_id: warehouse
position:
  x: 80
  y: 100
```

根据用户提供的订单查询库存，返回数量、来源和缺失信息。

## order
```md-node
name: 订单核对
agent_id: reviewer
position:
  x: 80
  y: 280
```

核对订单信息是否齐全，列出需要澄清的字段，不修改订单。

## report
```md-node
name: 汇总回复
agent_id: reviewer
position:
  x: 400
  y: 190
```

结合上游库存和订单结果，交付简短结论、依据与待确认事项。

[[#stock]] [[#order]]
