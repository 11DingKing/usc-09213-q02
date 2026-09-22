import assert from "node:assert/strict";
import test from "node:test";
import { makeActors, makeDesk } from "./helpers.mjs";
import { openJson } from "../src/security/crypto.mjs";

function plan(desk, admin, env, { riskLevel = "standard", intervalMs = 3_600_000, graceMs = 900_000 } = {}) {
  return desk.setSafetyPlan(admin, { journalistId: "j1", riskLevel, intervalMs, graceMs });
}

test("按期报平安保持安全状态", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist, security } = makeActors(desk);
  plan(desk, admin, env);

  env.advance(3_600_000);
  desk.checkin(journalist, { location: { city: "北京", place: "酒店" } });
  const status = desk.safetyStatus(security).find((s) => s.journalistId === "j1");
  assert.equal(status.status, "pending");
  assert.equal(status.escalationLevel, 0);
  assert.equal(status.lastLocation.city, "北京");
});

test("普通风险：逾期一级升级（仅安全岗），宽限后二级升级", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist, security, editor } = makeActors(desk);
  plan(desk, admin, env, { riskLevel: "standard", intervalMs: 3_600_000, graceMs: 900_000 });

  env.advance(3_600_001);
  let status = desk.safetyStatus(security).find((s) => s.journalistId === "j1");
  assert.equal(status.status, "overdue");
  assert.equal(status.escalationLevel, 1);
  // 一级升级只通知安全岗。
  let escalations = Object.values(desk.data.events).filter((e) => e.title.includes("失联升级"));
  assert.equal(escalations.length, 1);
  assert.deepEqual(escalations[0].requiredActorIds, ["s1"]);

  // 升级事件不携带定位；编辑看不到定位字段。
  const editorStatus = desk.safetyStatus(editor).find((s) => s.journalistId === "j1");
  assert.equal(editorStatus.lastLocation, undefined);

  env.advance(900_000);
  status = desk.safetyStatus(security).find((s) => s.journalistId === "j1");
  assert.equal(status.status, "escalated");
  assert.equal(status.escalationLevel, 2);
  escalations = Object.values(desk.data.events).filter((e) => e.title.includes("失联升级"));
  assert.equal(escalations.length, 2);
  assert.deepEqual(escalations[1].requiredActorIds.sort(), ["admin", "s1"]);

  // 任何升级载荷都不含位置信息。
  assert.ok(
    desk.data.ledger
      .filter((e) => e.type === "safety.escalation")
      .every((e) => JSON.stringify(e.payload).includes("location") === false),
  );

  // 迟到报平安解除升级。
  env.advance(1000);
  desk.checkin(journalist);
  status = desk.safetyStatus(security).find((s) => s.journalistId === "j1");
  assert.equal(status.escalationLevel, 0);
});

test("高风险：逾期立即二级升级", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, security } = makeActors(desk);
  plan(desk, admin, env, { riskLevel: "high", intervalMs: 1_800_000, graceMs: 600_000 });
  env.advance(1_800_001);
  const status = desk.safetyStatus(security).find((s) => s.journalistId === "j1");
  assert.equal(status.escalationLevel, 2);
  assert.equal(status.status, "escalated");
});

test("记者只能看到自己的安全状态", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist, journalist2 } = makeActors(desk);
  plan(desk, admin, env);
  const visible = desk.safetyStatus(journalist2).map((s) => s.journalistId);
  assert.deepEqual(visible, []);
  assert.deepEqual(desk.safetyStatus(journalist).map((s) => s.journalistId), ["j1"]);
});

test("位置密文绑定报平安记录，复制到其他记录无法解密", () => {
  const env = makeDesk();
  const { desk, store } = env;
  const { admin, journalist } = makeActors(desk);
  plan(desk, admin, env);
  env.advance(3_600_000);
  desk.checkin(journalist, { location: { city: "上海" } });
  const first = store.checkins.find((c) => c.locationEnvelope);
  assert.ok(first);
  // 篡改：尝试把密文挂到另一个 AAD 下。
  assert.throws(() => openJson(first.locationEnvelope.sealed, env.key, "checkin:forged"));
});
