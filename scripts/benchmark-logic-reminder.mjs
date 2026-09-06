// Offline synthetic benchmark. Does not call a model or touch the user's LEM store.
// Run after building Runtime: node --expose-gc scripts/benchmark-logic-reminder.mjs
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { LogicMemoryStore } from "../packages/bush-runtime/dist/logicMemory.js";
import { collectLogicReminderTexts } from "../packages/bush-runtime/dist/logicReminder.js";

const root = await mkdtemp(join(tmpdir(), "cardbush-lem-benchmark-"));
const scenarios = [
  [20, 10], [200, 100], [1000, 1000],
];
try {
  for (const [turnCount, lessonCount] of scenarios) {
    const path = join(root, `${turnCount}.json`);
    const lessons = Array.from({ length: lessonCount }, (_, i) => ({ logic_id: `logic_${i}`,
      scenario: `核对文件编码和网络连接 ${i}`, conditions: ["现场验证"],
      bias: "没有检查原始数据就做假设", correction: "查看实际证据，构建最小复现，再核对验证结果和适用条件。",
    }));
    await writeFile(path, JSON.stringify(lessons));
    const session = { supersededMessageIds: [], turns: Array.from({ length: turnCount }, (_, i) => ({
      turnId: `turn_${i}`, status: "completed", messages: [
        { messageId: `user_${i}`, message: { role: "user", content: `${i}: ${"检查项目的文件编码、网络连接和运行结果，并提供可以复核的验证证据。".repeat(5)}` } },
        { messageId: `reply_${i}`, message: { role: "assistant", toolCalls: [], content: `${i}: ${"本轮已查看文件内容及日志，核对网络连接与编码，完成最小复现和测试，记录观察事实与尚未验证的部分。".repeat(20)}` } },
      ],
    })) };
    for (const includeFinalReplies of [false, true]) {
      const memory = new LogicMemoryStore(path);
      const inputs = { session: includeFinalReplies ? session : {
        ...session, turns: session.turns.map(turn => ({ ...turn, messages: turn.messages.slice(0, 1) })),
      }, turnId: "current", currentMessages: [{ role: "user", content: "继续核对验证" }] };
      const samples = [];
      global.gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      let matched = false;
      let sourceChars = 0;
      for (let i = 0; i < 6; i++) {
        const start = performance.now();
        const texts = collectLogicReminderTexts(inputs);
        matched = await memory.hasConversationMatch(texts);
        samples.push(performance.now() - start);
        sourceChars = texts.reduce((sum, text) => sum + text.length, 0);
      }
      const warmed = samples.slice(1).sort((a, b) => a - b);
      global.gc?.();
      const retainedHeapMiB = (process.memoryUsage().heapUsed - heapBefore) / 1024 ** 2;
      const nextStart = performance.now();
      await memory.hasConversationMatch([...collectLogicReminderTexts(inputs), "新一轮用户指令：请额外检查 UTF-16 字节序和 ECONNRESET 的验证证据。"]);
      const nextTurnMs = performance.now() - nextStart;
      console.log(JSON.stringify({ turnCount, lessonCount, includeFinalReplies, sourceChars, matched,
        coldMs: +samples[0].toFixed(2), medianMs: +warmed[2].toFixed(2), maxWarmMs: +warmed.at(-1).toFixed(2),
        nextTurnMs: +nextTurnMs.toFixed(2), ...(global.gc ? { retainedHeapMiB: +retainedHeapMiB.toFixed(2) } : {}) }));
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
