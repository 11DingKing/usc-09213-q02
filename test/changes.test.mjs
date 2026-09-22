import assert from "node:assert/strict";
import test from "node:test";
import { HOUR, makeApp } from "./helpers.mjs";

test("临时变更：全员确认后生效，确认人收到带期限的通知", async (t) => {
  const { api } = await makeApp(t);
  await api("tok-jour-1", "POST", "/v1/itineraries", {
    id: "itn-1",
    city: "上海",
    startAt: "2026-09-23T01:00:00Z",
    endAt: "2026-09-23T09:00:00Z",
  });

  const proposed = await api("tok-jour-1", "POST", "/v1/changes", {
    id: "chg-1",
    entityType: "itinerary",
    entityId: "itn-1",
    patch: { city: "广州", venue: "广交会展馆" },
    confirmBy: "2026-09-22T12:00:00Z",
    requiredConfirmers: ["ed-1"],
    reason: "采访对象临时改址",
  });
  assert.equal(proposed.status, 201);
  assert.equal(proposed.body.status, "pending");

  // 确认人收到带确认期限的通知。
  const notices = await api("tok-ed-1", "GET", "/v1/notifications");
  const notice = notices.body.find((n) => n.kind === "change.proposed" && n.data.changeId === "chg-1");
  assert.ok(notice, "确认人应收到变更通知");
  assert.equal(notice.data.confirmBy, "2026-09-22T12:00:00.000Z");

  // 无关成员看不到该变更。
  assert.equal((await api("tok-fin-1", "GET", "/v1/changes/chg-1")).status, 403);

  // 确认前行程未变；确认后补丁生效。
  assert.equal((await api("tok-ed-1", "GET", "/v1/itineraries/itn-1")).body.city, "上海");
  const confirmed = await api("tok-ed-1", "POST", "/v1/changes/chg-1/confirm");
  assert.equal(confirmed.body.status, "applied");
  const after = await api("tok-ed-1", "GET", "/v1/itineraries/itn-1");
  assert.equal(after.body.city, "广州");
  assert.equal(after.body.venue, "广交会展馆");
});

test("临时变更：超过确认期限未确认自动失效，补丁不生效", async (t) => {
  const { api, clock } = await makeApp(t);
  await api("tok-jour-1", "POST", "/v1/itineraries", {
    id: "itn-2",
    city: "成都",
    startAt: "2026-09-23T01:00:00Z",
    endAt: "2026-09-23T09:00:00Z",
  });
  await api("tok-jour-1", "POST", "/v1/changes", {
    id: "chg-2",
    entityType: "itinerary",
    entityId: "itn-2",
    patch: { city: "重庆" },
    confirmBy: "2026-09-22T06:00:00Z",
    requiredConfirmers: ["ed-1", "sec-1"],
  });

  // 只有一人确认，随后时钟越过确认期限。
  await api("tok-ed-1", "POST", "/v1/changes/chg-2/confirm");
  clock.advance(7 * HOUR);

  const res = await api("tok-sec-1", "POST", "/v1/changes/chg-2/confirm");
  assert.equal(res.status, 409, "逾期后不能再确认");
  const change = await api("tok-ed-1", "GET", "/v1/changes/chg-2");
  assert.equal(change.body.status, "expired");
  assert.equal((await api("tok-ed-1", "GET", "/v1/itineraries/itn-2")).body.city, "成都");

  // 提议人收到失效通知。
  const notices = await api("tok-jour-1", "GET", "/v1/notifications");
  assert.ok(notices.body.some((n) => n.kind === "change.expired" && n.data.changeId === "chg-2"));
});
