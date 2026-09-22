import assert from "node:assert/strict";
import test from "node:test";
import { makeActors, makeDesk } from "./helpers.mjs";
import { verifyChain } from "../src/security/ledger.mjs";

test("编辑可验证报道链路，但看不到未获授权的来源内容", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist, editor } = makeActors(desk);

  const source = desk.createRecord(journalist, {
    tier: 3,
    subject: "tour",
    sourceId: "src-9",
    title: "来源档案",
    body: "绝密身份信息",
  });
  desk.updateRecord(journalist, { id: source.id, baseVersion: 1, body: "补充联系方式" });

  const report = desk.verifyRecord(editor, source.id);
  assert.equal(report.contentIntact, true);
  assert.equal(report.ledgerChainOk, true);
  assert.equal(report.version, 2);
  assert.equal(report.viewerMayReadPlaintext, false);
  // 验证结果本身不含任何明文字段。
  assert.ok(!JSON.stringify(report).includes("绝密"));
  assert.ok(!JSON.stringify(report).includes("联系方式"));
  // 账本中存在创建与更新两个锚点。
  assert.deepEqual(report.ledgerAnchors.map((a) => a.type), ["record.create", "record.update"]);

  // 直接读取仍被拒绝。
  assert.throws(() => desk.readRecord(editor, source.id), /加密来源/);
});

test("密文被篡改时链路验证失败", () => {
  const env = makeDesk();
  const { desk, store } = env;
  const { journalist, editor } = makeActors(desk);
  const source = desk.createRecord(journalist, {
    tier: 3,
    subject: "tour",
    sourceId: "src-9",
    title: "来源档案",
    body: "秘密",
  });
  const sealed = store.records[source.id].envelope.sealed;
  sealed.ciphertext = sealed.ciphertext[0] === "A" ? `B${sealed.ciphertext.slice(1)}` : `A${sealed.ciphertext.slice(1)}`;
  const report = desk.verifyRecord(editor, source.id);
  assert.equal(report.contentIntact, false);
});

test("账本条目篡改可被独立校验发现", () => {
  const env = makeDesk();
  const { desk } = env;
  const { journalist } = makeActors(desk);
  desk.createRecord(journalist, { tier: 1, subject: "tour", title: "x" });
  const entries = desk.data.ledger;
  assert.equal(verifyChain(entries).ok, true);

  const tampered = entries.map((e) => ({ ...e }));
  tampered[0].actorId = "forged";
  assert.equal(verifyChain(tampered).ok, false);

  // 删除中间条目导致断链。
  const broken = entries.filter((_, i) => i !== 1).map((e, i) => ({ ...e, index: i }));
  assert.equal(verifyChain(broken).ok, false);
});

test("事件时间与接收时间分别记录", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist } = makeActors(desk);
  desk.setSafetyPlan(admin, { journalistId: "j1", riskLevel: "standard", intervalMs: 3_600_000, graceMs: 0 });
  env.advance(3_600_000);
  desk.checkin(journalist, { at: env.now - 10_000 });
  const entry = desk.data.ledger.find((e) => e.type === "safety.checkin");
  assert.equal(entry.eventTime, env.now - 10_000);
  assert.equal(entry.receivedAt, env.now);
});
