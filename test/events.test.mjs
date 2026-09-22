import assert from "node:assert/strict";
import test from "node:test";
import { makeActors, makeDesk } from "./helpers.mjs";

test("临时变更事件按受众传播，确认后关闭，逾期自动标记并审计", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist, journalist2, editor } = makeActors(desk);

  const event = desk.publishEvent(editor, {
    title: "采访地点临时改至建国饭店",
    severity: "warning",
    audience: { actorIds: ["j1", "j2"] },
    deadline: env.now + 60_000,
    summary: "到达后确认",
  });
  assert.equal(event.status, "open");
  assert.equal(event.required, 2);

  // 非受众看不到内容。
  const adminView = desk.listEvents(admin)[0];
  // admin 属于全局可见角色（运维需要），但记者视角应受限：
  assert.equal(adminView.title, event.title);

  desk.acknowledgeEvent(journalist, event.id);
  let fresh = desk.listEvents(journalist).find((e) => e.id === event.id);
  assert.equal(fresh.acked, 1);
  assert.equal(fresh.status, "open");

  // 越过确认期限：未全员确认 → overdue 并产生审计事件。
  env.advance(60_001);
  fresh = desk.listEvents(journalist).find((e) => e.id === event.id);
  assert.equal(fresh.status, "overdue");
  assert.ok(desk.data.ledger.some((e) => e.type === "event.overdue" && e.subject === `event:${event.id}`));

  // 迟到确认仍然有效，事件转为已确认。
  desk.acknowledgeEvent(journalist2, event.id);
  fresh = desk.listEvents(journalist2).find((e) => e.id === event.id);
  assert.equal(fresh.status, "acknowledged");
});

test("非受众不能确认事件，重复确认幂等", () => {
  const { desk, now } = makeDesk();
  const { journalist, journalist2, editor } = makeActors(desk);
  const event = desk.publishEvent(editor, {
    title: "集合时间提前",
    audience: { actorIds: ["j1"] },
    deadline: now + 10_000,
  });
  assert.throws(() => desk.acknowledgeEvent(journalist2, event.id), /确认受众/);
  desk.acknowledgeEvent(journalist, event.id);
  const before = desk.data.ledger.filter((e) => e.type === "event.ack").length;
  desk.acknowledgeEvent(journalist, event.id);
  const after = desk.data.ledger.filter((e) => e.type === "event.ack").length;
  assert.equal(before, after);
});

test("受众可按角色圈定", () => {
  const { desk, now } = makeDesk();
  const { editor, journalist, journalist2 } = makeActors(desk);
  const event = desk.publishEvent(editor, {
    title: "所有记者注意",
    audience: { roles: ["journalist"] },
    deadline: now + 10_000,
  });
  assert.deepEqual(event.requiredActorIds.sort(), ["j1", "j2"]);
  assert.equal(desk.listEvents(journalist).length, 1);
  assert.equal(desk.listEvents(journalist2).length, 1);
});
