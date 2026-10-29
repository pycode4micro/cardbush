---
name: Order review
team:
  id: order-review
  description: Check inventory and orders in parallel, then summarize
  max_parallel: 2
---

# Order review

[English](team-order-review.en.md) · [简体中文](team-order-review.md)

## Why collaborate this way

Inventory and order details come from different sources. Check them separately before drawing conclusions, then preserve evidence and missing information in the final result. The registered employee IDs `warehouse` and `reviewer` must exist before execution.

## notes
```md-node
name: Discussion and notes
```

This is ordinary documentation, not an executable node. Record the checks under [[#stock|Inventory lookup]] and [[#order|Order verification]].

## stock
```md-node
name: Inventory lookup
agent_id: warehouse
depends_on: []
position:
  x: 80
  y: 100
```

Look up inventory for the supplied order. Return quantities, sources and missing information.

## order
```md-node
name: Order verification
agent_id: reviewer
depends_on: []
position:
  x: 80
  y: 280
```

Check completeness and list fields requiring clarification. Do not modify the order.

## report
```md-node
name: Final report
agent_id: reviewer
depends_on: [stock, order]
position:
  x: 400
  y: 190
```

Combine the upstream findings into a brief conclusion, evidence and outstanding questions.
