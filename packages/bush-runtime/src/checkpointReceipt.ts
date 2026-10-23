/** A committed single-source merge already carries its entire authored summary
 * in the adjacent native call. Reference that field instead of repeating it.
 * Multi-source incremental and staged receipts still carry their full ledger. */
export function referenceSingleCheckpointSummary(receipt: Record<string, any>, call: { id: string; argumentsText: string }): Record<string, any> {
  const entries = receipt.summaries;
  if (!receipt.complete || !Array.isArray(entries) || entries.length !== 1) return receipt;
  try {
    const updates = JSON.parse(call.argumentsText).updates;
    if (!Array.isArray(updates) || updates.length !== 1 || updates[0]?.source !== entries[0]?.source ||
      typeof updates[0]?.summary !== 'string' || updates[0].summary.trim() !== entries[0].summary) return receipt;
    const { summaries: _summaries, ...rest } = receipt;
    const { summary: _summary, ...identity } = entries[0];
    return { ...rest, summary_from_call: { ...identity, tool_call_id: call.id, argument: 'updates[0].summary' } };
  } catch { return receipt; }
}

/** Resolve only an explicit successful receipt reference to its paired call.
 * Rejected/unrelated tool arguments cannot become inherited summary evidence. */
export function checkpointReceiptEntries(receipt: Record<string, any>, call: { id: string; argumentsText: string }): Array<Record<string, any>> {
  if (Array.isArray(receipt.summaries)) return receipt.summaries;
  const ref = receipt.summary_from_call;
  if (receipt.complete !== true || !ref || ref.tool_call_id !== call.id || ref.argument !== 'updates[0].summary') return [];
  try {
    const updates = JSON.parse(call.argumentsText).updates;
    if (!Array.isArray(updates) || updates.length !== 1 || updates[0]?.source !== ref.source || typeof updates[0]?.summary !== 'string') return [];
    const { tool_call_id: _id, argument: _argument, ...identity } = ref;
    return [{ ...identity, summary: updates[0].summary.trim() }];
  } catch { return []; }
}
