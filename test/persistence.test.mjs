import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Desk } from "../src/desk.mjs";
import { Store } from "../src/store.mjs";
import { Clock } from "../src/security/clock.mjs";
import { makeActors, makeDesk } from "./helpers.mjs";

function reopen(dataFile, key, wall) {
  const store = new Store(dataFile, { nodeId: "desk-test" });
  let t = wall;
  const clock = new Clock(() => t, 0);
  const desk = new Desk(store, clock, key);
  return {
    desk,
    advance(ms) {
      t += ms;
      desk.sweep();
    },
    save() {
      store.save();
    },
  };
}

test("系统恢复后数据、密文与授权状态延续，到期授权仍被收紧", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-"));
  const dataFile = path.join(dir, "desk.json");
  try {
    const env = makeDesk({ dataFile });
    const { desk, key } = env;
    const { admin, journalist, editor } = makeActors(desk);
    const source = desk.createRecord(journalist, {
      tier: 3,
      subject: "tour",
      sourceId: "src-9",
      title: "来源",
      body: "秘密",
    });
    desk.issueGrant(admin, { actorId: "e1", tier: 3, scope: { kind: "source", value: "src-9" }, expiresAt: env.now + 10_000 });
    desk.setSafetyPlan(admin, { journalistId: "j1", riskLevel: "standard", intervalMs: 3_600_000, graceMs: 900_000 });
    desk.save();

    // 重启，时钟继续向后走。
    const next = reopen(dataFile, key, env.now + 10_001);
    assert.throws(() => next.desk.readRecord(editor, source.id), /加密来源/);
    // 密文仍可由持有授权者在重新授权后解密（密钥一致）。
    next.desk.issueGrant(admin, { actorId: "e1", tier: 3, scope: { kind: "source", value: "src-9" } });
    assert.equal(next.desk.readRecord(editor, source.id).body, "秘密");

    // 失联计时在重启后继续：越过间隔与宽限仍未报平安 → 二级升级。
    next.advance(4_490_000);
    const status = next.desk.safetyStatus(next.desk.data.actors.s1)[0];
    assert.equal(status.escalationLevel, 2);
    assert.equal(status.status, "escalated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("时钟单调：系统时间回拨不会重开已逾期状态", () => {
  const env = makeDesk();
  const { desk } = env;
  makeActors(desk);
  desk.setSafetyPlan(env.store.actors.admin, { journalistId: "j1", riskLevel: "standard", intervalMs: 3_600_000, graceMs: 900_000 });
  env.advance(3_600_001);
  assert.equal(env.store.checkins.at(-1).escalationLevel, 1);
  // 模拟系统时钟被回拨到过去。
  env.setTime(env.now - 2 * 3_600_000);
  assert.equal(env.store.checkins.at(-1).escalationLevel, 1);
});

test("账本快照被篡改时系统拒绝启动", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-"));
  const dataFile = path.join(dir, "desk.json");
  try {
    const env = makeDesk({ dataFile });
    makeActors(env.desk);
    env.desk.save();
    const raw = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    raw.ledger[0].type = "tampered";
    fs.writeFileSync(dataFile, JSON.stringify(raw));
    assert.throws(() => reopen(dataFile, env.key, env.now), /哈希校验失败/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
