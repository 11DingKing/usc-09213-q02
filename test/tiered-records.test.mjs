import assert from "node:assert/strict";
import test from "node:test";
import { makeActors, makeDesk } from "./helpers.mjs";

test("分层记录：公开行程可读，受限与加密层默认不可见", () => {
  const { desk, store } = makeDesk();
  const { admin, journalist, editor } = makeActors(desk);

  const pub = desk.createRecord(journalist, {
    tier: 1,
    subject: "china-tour",
    title: "公开行程：北京-上海",
    body: "9月24日乘高铁前往上海",
  });
  const plan = desk.createRecord(journalist, {
    tier: 2,
    subject: "china-tour",
    title: "受限采访计划",
    body: "约见某机构内部人士",
  });
  const source = desk.createRecord(journalist, {
    tier: 3,
    subject: "china-tour",
    sourceId: "src-9",
    title: "加密来源档案",
    body: { realName: "张某", contact: "信号号码..." },
  });

  // tier1 任何人可见明文；列表只返回有权限的层。
  const visibleToEditor = desk.listRecords(editor);
  assert.deepEqual(visibleToEditor.map((r) => r.id), [pub.id]);
  assert.equal(desk.readRecord(editor, pub.id).body, "9月24日乘高铁前往上海");

  assert.throws(() => desk.readRecord(editor, plan.id), /有效授权/);
  assert.throws(() => desk.readRecord(editor, source.id), /加密来源/);

  // 密文在落盘数据中不包含明文片段。
  const raw = JSON.stringify(store.records[source.id].envelope);
  assert.ok(!raw.includes("张某"));
  assert.ok(!raw.includes("信号号码"));
});

test("授权按层级与范围生效，到期后访问自动收紧", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist, editor } = makeActors(desk);

  const source = desk.createRecord(journalist, {
    tier: 3,
    subject: "china-tour",
    sourceId: "src-9",
    title: "加密来源档案",
    body: "敏感内容",
  });

  // 只有 tier2 授权仍不足以读 tier3。
  desk.issueGrant(admin, { actorId: "e1", tier: 2, scope: { kind: "subject", value: "china-tour" }, expiresAt: env.now + 10_000 });
  assert.throws(() => desk.readRecord(editor, source.id), /加密来源/);

  // 补发 tier3 的来源级授权。
  desk.issueGrant(admin, { actorId: "e1", tier: 3, scope: { kind: "source", value: "src-9" }, expiresAt: env.now + 5_000 });
  assert.equal(desk.readRecord(editor, source.id).body, "敏感内容");

  // 授权到期：密文仍在，但访问被自动收紧。
  env.advance(5_001);
  assert.throws(() => desk.readRecord(editor, source.id), /加密来源/);
  assert.ok(desk.data.records[source.id]);
});

test("范围授权不能横向访问其他来源", () => {
  const { desk } = makeDesk();
  const { admin, journalist, editor } = makeActors(desk);
  desk.createRecord(journalist, { tier: 3, subject: "tour-a", sourceId: "src-1", title: "A", body: "甲" });
  const other = desk.createRecord(journalist, { tier: 3, subject: "tour-b", sourceId: "src-2", title: "B", body: "乙" });
  desk.issueGrant(admin, { actorId: "e1", tier: 3, scope: { kind: "source", value: "src-1" } });
  assert.throws(() => desk.readRecord(editor, other.id), /加密来源/);
});
