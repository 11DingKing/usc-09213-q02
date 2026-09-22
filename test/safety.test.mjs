import assert from "node:assert/strict";
import test from "node:test";
import { HOUR, makeApp, seedJournalist } from "./helpers.mjs";

test("失联升级：按风险等级逐级升级，签到后回落", async (t) => {
  const { api, clock } = await makeApp(t);
  await seedJournalist(api); // 中风险，6 小时间隔 → L1=6h, L2=12h, L3=24h

  await api("tok-jour-1", "POST", "/v1/safety/checkins", {
    location: { lat: 39.9042, lon: 116.4074, label: "北京" },
  });
  let status = await api("tok-ed-1", "GET", "/v1/safety/jour-1");
  assert.equal(status.body.level, 0);

  clock.advance(7 * HOUR);
  status = await api("tok-ed-1", "GET", "/v1/safety/jour-1");
  assert.equal(status.body.level, 1);

  clock.advance(6 * HOUR); // 累计 13h
  status = await api("tok-ed-1", "GET", "/v1/safety/jour-1");
  assert.equal(status.body.level, 2);

  clock.advance(12 * HOUR); // 累计 25h
  status = await api("tok-ed-1", "GET", "/v1/safety/jour-1");
  assert.equal(status.body.level, 3);

  // 签到后等级回落，重新计时。
  await api("tok-jour-1", "POST", "/v1/safety/checkins", { note: "已安全抵达酒店" });
  status = await api("tok-ed-1", "GET", "/v1/safety/jour-1");
  assert.equal(status.body.level, 0);
});

test("失联升级：定位只给安全角色，编辑通知不含位置", async (t) => {
  const { api, clock } = await makeApp(t);
  await seedJournalist(api);
  await api("tok-jour-1", "POST", "/v1/safety/checkins", {
    location: { lat: 30.5728, lon: 104.0668, label: "成都某茶馆" },
  });

  clock.advance(25 * HOUR); // 触发 L3
  const status = await api("tok-ed-1", "GET", "/v1/safety/jour-1");
  assert.equal(status.body.level, 3);
  assert.ok(!("location" in status.body), "状态接口不得携带定位");

  // 编辑的升级通知不含定位。
  const edNotices = await api("tok-ed-1", "GET", "/v1/notifications");
  const edEscalation = edNotices.body.find((n) => n.kind === "safety.escalation");
  assert.ok(edEscalation, "编辑应收到升级通知");
  assert.ok(!edEscalation.data.location, "编辑通知不得包含定位");

  // 安全官的通知包含最后已知位置。
  const secNotices = await api("tok-sec-1", "GET", "/v1/notifications");
  const secEscalation = secNotices.body.find((n) => n.kind === "safety.escalation" && n.data.level === 3);
  assert.ok(secEscalation, "安全官应收到 L3 通知");
  assert.equal(secEscalation.data.location.label, "成都某茶馆");

  // 定位接口：编辑与财务被拒，安全官与本人可读。
  assert.equal((await api("tok-ed-1", "GET", "/v1/safety/jour-1/location")).status, 403);
  assert.equal((await api("tok-fin-1", "GET", "/v1/safety/jour-1/location")).status, 403);
  const secView = await api("tok-sec-1", "GET", "/v1/safety/jour-1/location");
  assert.equal(secView.status, 200);
  assert.equal(secView.body.location.label, "成都某茶馆");
  assert.equal((await api("tok-jour-1", "GET", "/v1/safety/jour-1/location")).status, 200);
});

test("失联升级：高风险记者升级更快", async (t) => {
  const { api, clock } = await makeApp(t);
  await seedJournalist(api, { riskLevel: "high", checkinIntervalHours: 4 }); // L1=2h, L2=4h, L3=8h
  await api("tok-jour-1", "POST", "/v1/safety/checkins", {});

  clock.advance(3 * HOUR);
  assert.equal((await api("tok-ed-1", "GET", "/v1/safety/jour-1")).body.level, 1);
  clock.advance(6 * HOUR); // 累计 9h
  assert.equal((await api("tok-ed-1", "GET", "/v1/safety/jour-1")).body.level, 3);
});
