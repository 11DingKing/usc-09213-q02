import assert from "node:assert/strict";
import test from "node:test";
import { makeActors, makeDesk } from "./helpers.mjs";

test("离线回传：opId 幂等，重复回传不重复生效", () => {
  const env = makeDesk();
  const { desk } = env;
  const { journalist } = makeActors(desk);

  const op = {
    opId: "client-a-1",
    type: "record.create",
    entityId: "rec-offline-1",
    payload: { tier: 1, subject: "tour", title: "离线写下的行程", body: "..." },
  };
  const first = desk.sync(journalist, [op]);
  assert.equal(first.results[0].status, "applied");
  assert.equal(first.results[0].duplicate, false);

  const second = desk.sync(journalist, [op]);
  assert.equal(second.results[0].status, "applied");
  assert.equal(second.results[0].duplicate, true);
  assert.equal(Object.keys(desk.data.records).length, 1);
  assert.equal(desk.data.ledger.filter((e) => e.type === "record.create").length, 1);
});

test("离线编辑冲突：服务端版本已前进时返回冲突，双方修改都不丢", () => {
  const env = makeDesk();
  const { desk } = env;
  const { journalist } = makeActors(desk);

  const rec = desk.createRecord(journalist, { tier: 1, subject: "tour", title: "v1", body: "编辑部版本" });
  // 另一节点已把记录推进到 v2。
  desk.updateRecord(journalist, { id: rec.id, baseVersion: 1, title: "v2-编辑改" });

  // 弱网设备基于 v1 的离线修改回传：检测到冲突，拒绝覆盖。
  const result = desk.sync(journalist, [
    {
      opId: "client-a-2",
      type: "record.update",
      payload: { id: rec.id, baseVersion: 1, title: "v2-记者离线改" },
    },
  ]);
  assert.equal(result.results[0].status, "rejected");
  assert.equal(result.results[0].error.code, "conflict");
  assert.equal(result.results[0].error.details.currentVersion, 2);
  // 服务端版本完好保留。
  assert.equal(desk.readRecord(journalist, rec.id).title, "v2-编辑改");
});

test("同批操作逐条隔离：一条被拒不影响其他条目", () => {
  const env = makeDesk();
  const { desk } = env;
  const { journalist } = makeActors(desk);
  const rec = desk.createRecord(journalist, { tier: 1, subject: "tour", title: "v1" });
  desk.updateRecord(journalist, { id: rec.id, baseVersion: 1, title: "v2" });

  const out = desk.sync(journalist, [
    { opId: "ok-1", type: "record.create", entityId: "r-new", payload: { tier: 1, subject: "tour", title: "新记录" } },
    { opId: "stale-1", type: "record.update", payload: { id: rec.id, baseVersion: 1, title: "陈旧修改" } },
  ]);
  assert.equal(out.results[0].status, "applied");
  assert.equal(out.results[1].status, "rejected");
});

test("离线报平安携带事件时间，接收时间以服务器为准，未来时间被拒", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist } = makeActors(desk);
  desk.setSafetyPlan(admin, { journalistId: "j1", riskLevel: "standard", intervalMs: 3_600_000, graceMs: 900_000 });

  // 设备在弱网中 2 小时后才回传报平安（事件时间合法）。
  env.advance(2 * 3_600_000);
  const out = desk.sync(journalist, [
    { opId: "c1", type: "safety.checkin", eventTime: env.now - 3_600_000, payload: {} },
  ]);
  assert.equal(out.results[0].status, "applied");
  const entry = desk.data.ledger.find((e) => e.type === "safety.checkin");
  assert.ok(entry.eventTime !== entry.receivedAt);
  assert.equal(entry.eventTime, env.now - 3_600_000);

  // 不能用未来的设备时间操纵计时。
  const bad = desk.sync(journalist, [
    { opId: "c2", type: "safety.checkin", eventTime: env.now + 999_999, payload: {} },
  ]);
  assert.equal(bad.results[0].status, "rejected");
});
