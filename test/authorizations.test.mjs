import assert from "node:assert/strict";
import test from "node:test";
import { HOUR, makeApp } from "./helpers.mjs";

test("采访授权：到期自动收紧访问，并留下过期审计", async (t) => {
  const { api, clock, app } = await makeApp(t);
  await api("tok-jour-1", "POST", "/v1/plans", {
    id: "pln-1",
    title: "某企业暗访计划",
    scheduledAt: "2026-09-25T02:00:00Z",
  });
  await api("tok-admin", "POST", "/v1/authorizations", {
    id: "azn-1",
    subjectId: "ed-1",
    scopeType: "plan",
    scopeId: "pln-1",
    validFrom: "2026-09-22T00:00:00Z",
    validUntil: "2026-09-22T08:00:00Z",
  });

  // 有效期内可读。
  assert.equal((await api("tok-ed-1", "GET", "/v1/plans/pln-1")).status, 200);

  // 时钟越过有效期：无需任何后台任务，访问立即收紧。
  clock.advance(9 * HOUR);
  const denied = await api("tok-ed-1", "GET", "/v1/plans/pln-1");
  assert.equal(denied.status, 403);

  // 过期状态已落盘，且有系统审计记录。
  const auth = await api("tok-admin", "GET", "/v1/authorizations/azn-1");
  assert.equal(auth.body.status, "expired");
  const entries = app.audit.query({ action: "authorization.expired", entityId: "azn-1" });
  assert.equal(entries.length, 1);
});

test("采访授权：撤销后立即失效，非授予人不能撤销", async (t) => {
  const { api } = await makeApp(t);
  await api("tok-jour-1", "POST", "/v1/plans", {
    id: "pln-2",
    title: "某园区走访",
    scheduledAt: "2026-09-26T02:00:00Z",
  });
  await api("tok-admin", "POST", "/v1/authorizations", {
    id: "azn-2",
    subjectId: "ed-1",
    scopeType: "plan",
    scopeId: "pln-2",
    validFrom: "2026-09-22T00:00:00Z",
    validUntil: "2026-09-30T00:00:00Z",
  });
  assert.equal((await api("tok-ed-1", "GET", "/v1/plans/pln-2")).status, 200);

  // 无关成员不能撤销。
  assert.equal((await api("tok-fin-1", "POST", "/v1/authorizations/azn-2/revoke")).status, 403);
  // 授予人（管理员）撤销后立即收紧。
  assert.equal((await api("tok-admin", "POST", "/v1/authorizations/azn-2/revoke")).status, 200);
  assert.equal((await api("tok-ed-1", "GET", "/v1/plans/pln-2")).status, 403);
});
