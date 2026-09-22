import assert from "node:assert/strict";
import test from "node:test";
import { HOUR, makeApp, seedJournalist } from "./helpers.mjs";
import { createApp } from "../src/app.mjs";

test("系统恢复：重启后失联计时继续，逾期授权与变更照常推进", async (t) => {
  const first = await makeApp(t);
  const { api, clock, dataDir, config } = first;
  await seedJournalist(api);
  await api("tok-jour-1", "POST", "/v1/safety/checkins", {
    location: { lat: 23.1291, lon: 113.2644, label: "广州" },
  });
  await api("tok-jour-1", "POST", "/v1/plans", {
    id: "pln-1",
    title: "恢复期验证计划",
    scheduledAt: "2026-09-25T02:00:00Z",
  });
  await api("tok-admin", "POST", "/v1/authorizations", {
    id: "azn-1",
    subjectId: "ed-1",
    scopeType: "plan",
    scopeId: "pln-1",
    validFrom: "2026-09-22T00:00:00Z",
    validUntil: "2026-09-22T10:00:00Z",
  });
  await api("tok-jour-1", "POST", "/v1/itineraries", {
    id: "itn-1",
    city: "广州",
    startAt: "2026-09-23T01:00:00Z",
    endAt: "2026-09-23T09:00:00Z",
  });
  await api("tok-jour-1", "POST", "/v1/changes", {
    id: "chg-1",
    entityType: "itinerary",
    entityId: "itn-1",
    patch: { city: "深圳" },
    confirmBy: "2026-09-22T08:00:00Z",
    requiredConfirmers: ["ed-1"],
  });

  // 模拟系统宕机 26 小时：时钟前进，期间无人确认变更、授权到期、记者失联。
  clock.advance(26 * HOUR);
  await new Promise((resolve) => first.app.server.close(resolve));

  // 重启：从同一数据目录恢复，启动时自动推进所有计时。
  const restarted = createApp({ dataDir, clock, config });
  await new Promise((resolve) => restarted.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => restarted.server.close(resolve)));
  const port = restarted.server.address().port;
  const api2 = (token, method, pathName) =>
    fetch(`http://127.0.0.1:${port}${pathName}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  // 失联计时从宕机前的签到时间继续累计 → 直接评估为 L3。
  const status = await api2("tok-sec-1", "GET", "/v1/safety/jour-1");
  assert.equal(status.body.level, 3);
  assert.equal(status.body.lastCheckInAt, "2026-09-22T00:00:00.000Z");

  // 宕机期间到期的授权已收紧并落盘。
  const auth = await api2("tok-admin", "GET", "/v1/authorizations/azn-1");
  assert.equal(auth.body.status, "expired");
  assert.equal((await api2("tok-ed-1", "GET", "/v1/plans/pln-1")).status, 403);

  // 宕机期间逾期的变更已失效，行程未被修改。
  const change = await api2("tok-ed-1", "GET", "/v1/changes/chg-1");
  assert.equal(change.body.status, "expired");
  assert.equal((await api2("tok-ed-1", "GET", "/v1/itineraries/itn-1")).body.city, "广州");

  // 审计链跨重启保持完整。
  const verify = await api2("tok-sec-1", "GET", "/v1/audit/verify");
  assert.equal(verify.body.valid, true);
  assert.ok(verify.body.length > 0);
});
