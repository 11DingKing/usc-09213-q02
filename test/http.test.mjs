import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/httpApp.mjs";
import { makeActors, makeDesk } from "./helpers.mjs";

async function withServer(desk, run) {
  const server = createServer(desk);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, method, path, actorId, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(actorId ? { "x-actor-id": actorId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test("健康检查（内存装配）", async () => {
  const { desk } = makeDesk();
  await withServer(desk, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

test("身份头缺失或未知返回 401", async () => {
  const { desk } = makeDesk();
  await withServer(desk, async (base) => {
    const noHeader = await call(base, "GET", "/records");
    assert.equal(noHeader.status, 401);
    const unknown = await call(base, "GET", "/records", "nobody");
    assert.equal(unknown.status, 401);
  });
});

test("端到端：分层记录经 HTTP 强制授权，到期后收紧", async () => {
  const env = makeDesk();
  makeActors(env.desk);
  await withServer(env.desk, async (base) => {
    const created = await call(base, "POST", "/records", "j1", {
      tier: 3,
      subject: "tour",
      sourceId: "src-9",
      title: "来源档案",
      body: "机密",
    });
    assert.equal(created.status, 201);
    const id = created.json.id;

    let denied = await call(base, "GET", `/records/${id}`, "e1");
    assert.equal(denied.status, 403);

    const grant = await call(base, "POST", "/admin/grants", "admin", {
      actorId: "e1",
      tier: 3,
      scope: { kind: "source", value: "src-9" },
      expiresAt: env.now + 1000,
    });
    assert.equal(grant.status, 201);

    let allowed = await call(base, "GET", `/records/${id}`, "e1");
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.body, "机密");

    env.advance(1001);
    denied = await call(base, "GET", `/records/${id}`, "e1");
    assert.equal(denied.status, 403);

    // 无授权编辑仍可验证链路。
    const verify = await call(base, "GET", `/records/${id}/verify`, "e1");
    assert.equal(verify.status, 200);
    assert.equal(verify.json.contentIntact, true);
    assert.equal(verify.json.viewerMayReadPlaintext, false);
  });
});

test("端到端：同步通道幂等与冲突检测", async () => {
  const env = makeDesk();
  makeActors(env.desk);
  await withServer(env.desk, async (base) => {
    const op = {
      opId: "dev1",
      type: "record.create",
      entityId: "r1",
      payload: { tier: 1, subject: "tour", title: "离线记录" },
    };
    const first = await call(base, "POST", "/sync", "j1", { ops: [op] });
    assert.equal(first.status, 200);
    assert.equal(first.json.results[0].duplicate, false);
    const second = await call(base, "POST", "/sync", "j1", { ops: [op] });
    assert.equal(second.json.results[0].duplicate, true);

    const conflict = await call(base, "POST", "/sync", "j1", {
      ops: [{ opId: "dev2", type: "record.update", payload: { id: "r1", baseVersion: 99, title: "陈旧" } }],
    });
    assert.equal(conflict.json.results[0].error.code, "conflict");
  });
});

test("非法 JSON 返回 400", async () => {
  const { desk } = makeDesk();
  await withServer(desk, async (base) => {
    const response = await fetch(`${base}/records`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-actor-id": "admin" },
      body: "{不是json",
    });
    assert.equal(response.status, 400);
  });
});
