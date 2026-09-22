import assert from "node:assert/strict";
import test from "node:test";
import { makeApp } from "./helpers.mjs";
import { encrypt, generateContentKey, sha256 } from "../src/core/crypto.mjs";

async function seedReport(api) {
  await api("tok-jour-1", "POST", "/v1/plans", {
    id: "pln-1",
    title: "链上计划",
    summary: "某主题系列采访",
    scheduledAt: "2026-09-25T02:00:00Z",
  });
  const plaintext = "来源内容：某工厂排污记录。";
  await api("tok-jour-1", "POST", "/v1/sources", {
    id: "src-1",
    title: "排污记录",
    ciphertext: encrypt(generateContentKey(), plaintext),
    contentHash: sha256(plaintext),
  });
  await api("tok-jour-1", "POST", "/v1/notes", { id: "note-1", title: "速记", body: "现场记录" });
  const published = await api("tok-jour-1", "POST", "/v1/reports", {
    id: "rpt-1",
    title: "排污调查报道",
    entries: [
      { kind: "plan", refId: "pln-1" },
      { kind: "source", refId: "src-1" },
      { kind: "note", refId: "note-1" },
    ],
  });
  assert.equal(published.status, 201);
  return published.body;
}

test("报道链路：编辑可核验完整链路，且全程接触不到来源内容", async (t) => {
  const { api } = await makeApp(t);
  await seedReport(api);

  const verified = await api("tok-ed-1", "GET", "/v1/reports/rpt-1/verify");
  assert.equal(verified.status, 200);
  assert.equal(verified.body.valid, true);
  assert.equal(verified.body.checks.length, 3);
  assert.ok(verified.body.checks.every((c) => c.ok));

  // 核验响应只含哈希与结论，不含任何内容字段。
  const payload = JSON.stringify(verified.body);
  assert.ok(!payload.includes("排污记录"), "响应不得包含来源标题");
  assert.ok(!payload.includes("现场记录"), "响应不得包含笔记内容");
  assert.ok(!payload.includes("ciphertext"), "响应不得包含密文");

  // 编辑对该来源没有授权，核验能力不能用来换取内容。
  assert.equal((await api("tok-ed-1", "GET", "/v1/sources/src-1")).status, 403);
  assert.equal((await api("tok-ed-1", "GET", "/v1/sources/src-1/key")).status, 403);
});

test("报道链路：引用对象被篡改后核验失败并定位到条目", async (t) => {
  const { api, app } = await makeApp(t);
  await seedReport(api);

  // 模拟底层数据被篡改（绕过一切业务接口直接改存储）。
  app.store.update((s) => {
    s.plans["pln-1"].summary = "被篡改的摘要";
  });

  const verified = await api("tok-ed-1", "GET", "/v1/reports/rpt-1/verify");
  assert.equal(verified.body.valid, false);
  const broken = verified.body.checks.find((c) => !c.ok);
  assert.equal(broken.kind, "plan");
  assert.equal(broken.refIntact, false);
  assert.equal(broken.chainIntact, true, "链结构本身未变，是引用内容被改");
  // 其余条目仍然完好。
  assert.ok(verified.body.checks.filter((c) => c.ok).length === 2);
});

test("报道链路：密级不足的成员不能调用核验", async (t) => {
  const { api } = await makeApp(t);
  await seedReport(api);
  assert.equal((await api("tok-ed-2", "GET", "/v1/reports/rpt-1/verify")).status, 403);
});
