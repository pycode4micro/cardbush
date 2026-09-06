import assert from "node:assert/strict";
import test from "node:test";
import { LogicRetriever, retrieveLogic } from "../dist/logicRetrieval.js";

const networkLesson = {
  logic_id: "network",
  scenario: "Node http.request 测试中服务器提前返回 HTTP 413 并断开连接",
  bias: "复用连接池后出现 ECONNRESET，容易把偶发失败直接归因于服务端",
  correction: "用最小复现脚本隔离客户端连接复用，再判断服务端。修改后连跑多轮确认稳定。",
  tags: ["node", "http", "keep-alive"],
};

test("word segmentation removes cross-boundary and single-character false matches", () => {
  for (const query of [
    "窗口缩小后图片预览被遮挡，如何定位布局问题？",
    "核对财务报表中的金额合计，如何避免计算错误？",
    "后", "zqxjkv",
  ]) assert.deepEqual(retrieveLogic([networkLesson], [query]), [], query);
  assert.deepEqual(retrieveLogic([{ scenario: "连接，文件" }], ["接文"]), []);
  assert.equal(retrieveLogic([networkLesson], ["Node HTTP 413 keep-alive ECONNRESET"])[0].record.logic_id, "network");
});

test("BM25 uses corpus document frequency, term saturation and document-length normalization", () => {
  const records = [
    { logic_id: "short", scenario: "quartz quartz common" },
    { logic_id: "long", scenario: "quartz common other filler extra words length padding" },
    { logic_id: "common", scenario: "common other filler" },
  ];
  const ranked = retrieveLogic(records, ["quartz"]);
  assert.equal(ranked.length, 2);
  const expected = Math.log1p((3 - 2 + 0.5) / (2 + 0.5)) * 2 * 2.2 /
    (2 + 1.2 * (0.25 + 0.75 * 3 / (14 / 3)));
  assert.ok(Math.abs(ranked[0].score - expected) < 1e-12);
  assert.equal(ranked[0].record.logic_id, "short");
  assert.ok(ranked[0].score > ranked[1].score);
  assert.deepEqual(retrieveLogic(records, ["quartz quartz quartz"]), ranked);
});

test("BM25 scores do not depend on confidence, reward, feedback or model-generated labels", () => {
  const low = { ...networkLesson, confidence: 0.1, reward_score: -100, suppression_score: 100 };
  const high = { ...networkLesson, confidence: 0.98, reward_score: 100, suppression_score: 0 };
  assert.equal(retrieveLogic([low], ["http 413"])[0].score, retrieveLogic([high], ["http 413"])[0].score);
  assert.deepEqual(retrieveLogic([], ["http 413"]), []);
  assert.deepEqual(retrieveLogic([networkLesson], [""]), []);
});

test("normalizes Unicode and case and retrieves English and Chinese words without a domain dictionary", () => {
  const records = [{ scenario: "SOCKET socket 文件编码转换" }];
  const ascii = retrieveLogic(records, ["socket"]);
  assert.deepEqual(retrieveLogic(records, ["ＳＯＣＫＥＴ"]), ascii);
  assert.equal(retrieveLogic(records, ["文件编码"])[0].record, records[0]);
});

test("reusable tokenization stays equivalent to fresh retrieval across query and lesson changes", () => {
  const retriever = new LogicRetriever();
  const versions = [
    [[networkLesson], ["socket http 413"]],
    [[networkLesson], ["socket http 413", "ECONNRESET"]],
    [[{ ...networkLesson, scenario: "new encoding", bias: "", correction: "", tags: [] }], ["http 413"]],
    [[], ["http 413"]],
    [[networkLesson], ["文件编码"]],
    [[networkLesson], ["http 413"]],
  ];
  for (const [records, query] of versions) {
    assert.deepEqual(retriever.search(records, query), retrieveLogic(records, query));
  }
  retriever.clear();
  assert.deepEqual(retriever.search([networkLesson], ["http"]), retrieveLogic([networkLesson], ["http"]));
});
