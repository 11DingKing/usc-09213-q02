import assert from "node:assert/strict";
import test from "node:test";
import { makeApp } from "./helpers.mjs";

test("离线回传：基线版本不一致判定冲突，双方版本都保留", async (t) => {
  const { api } = await makeApp(t);
  const created = await api("tok-jour-1", "POST", "/v1/notes", {
    id: "note-1",
    title: "采访速记",
    body: "初稿",
  });
  assert.equal(created.body.version, 1);

  // 在线编辑把版本推进到 2。
  const online = await api("tok-jour-1", "PATCH", "/v1/notes/note-1", {
    baseVersion: 1,
    body: "在线修改稿",
  });
  assert.equal(online.body.version, 2);

  // 弱网离线端仍基于版本 1 回传 → 409 + 冲突记录。
  const stale = await api("tok-jour-1", "PATCH", "/v1/notes/note-1", {
    baseVersion: 1,
    body: "离线修改稿",
    occurredAt: "2026-09-22T03:00:00Z",
  });
  assert.equal(stale.status, 409);
  assert.ok(stale.body.error.details.conflictId);

  // 服务端内容未被覆盖，冲突中保留了客户端补丁。
  const current = await api("tok-jour-1", "GET", "/v1/notes/note-1");
  assert.equal(current.body.body, "在线修改稿");
  const conflicts = await api("tok-jour-1", "GET", "/v1/offline/conflicts");
  assert.equal(conflicts.body.length, 1);
  assert.equal(conflicts.body[0].clientPatch.body, "离线修改稿");
  assert.equal(conflicts.body[0].serverSnapshot.body, "在线修改稿");
});

test("离线回传：批量同步逐条应用或登记冲突，可人工解决", async (t) => {
  const { api } = await makeApp(t);
  await api("tok-jour-1", "POST", "/v1/notes", { id: "note-a", title: "A", body: "旧" });
  await api("tok-jour-1", "PATCH", "/v1/notes/note-a", { baseVersion: 1, body: "在线新版" });

  const sync = await api("tok-jour-1", "POST", "/v1/offline/sync", {
    items: [
      { id: "note-a", baseVersion: 1, body: "离线旧版" }, // 冲突
      { id: "note-b", title: "B", body: "离线新建" }, // 新建
      { title: "C", body: "无 id 新建" }, // 新建
    ],
  });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.applied.length, 2);
  assert.equal(sync.body.conflicts.length, 1);

  // 采用客户端版本解决冲突。
  const conflictId = sync.body.conflicts[0].id;
  const resolved = await api("tok-jour-1", "POST", `/v1/offline/conflicts/${conflictId}/resolve`, {
    choice: "client",
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.note.body, "离线旧版");
  assert.equal(resolved.body.note.version, 3);
  assert.equal((await api("tok-jour-1", "GET", "/v1/offline/conflicts")).body.length, 0);

  // 已解决的冲突不能再次解决。
  assert.equal(
    (await api("tok-jour-1", "POST", `/v1/offline/conflicts/${conflictId}/resolve`, { choice: "server" })).status,
    409,
  );
});
