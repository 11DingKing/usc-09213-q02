import assert from "node:assert/strict";
import test from "node:test";
import { makeApp } from "./helpers.mjs";
import { decrypt, encrypt, generateContentKey, sha256, unwrapKey, wrapKey } from "../src/core/crypto.mjs";

test("公开行程层：任何已认证成员可读，未认证拒绝", async (t) => {
  const { api } = await makeApp(t);
  const created = await api("tok-jour-1", "POST", "/v1/itineraries", {
    id: "itn-1",
    city: "北京",
    venue: "某会议中心",
    startAt: "2026-09-23T01:00:00Z",
    endAt: "2026-09-23T09:00:00Z",
    summary: "公开论坛采访",
  });
  assert.equal(created.status, 201);

  for (const token of ["tok-jour-1", "tok-ed-1", "tok-ed-2", "tok-fin-1", "tok-sec-1"]) {
    const res = await api(token, "GET", "/v1/itineraries/itn-1");
    assert.equal(res.status, 200, `${token} 应能读取公开行程`);
    assert.equal(res.body.city, "北京");
  }
  const anon = await api(null, "GET", "/v1/itineraries/itn-1");
  assert.equal(anon.status, 401);
});

test("受限采访计划层：密级不足或无授权均被拒，授权后可读", async (t) => {
  const { api } = await makeApp(t);
  const created = await api("tok-jour-1", "POST", "/v1/plans", {
    id: "pln-1",
    title: "某部委专访",
    scheduledAt: "2026-09-25T02:00:00Z",
    location: "北京",
  });
  assert.equal(created.status, 201);

  // 负责人可读
  assert.equal((await api("tok-jour-1", "GET", "/v1/plans/pln-1")).status, 200);
  // restricted 密级编辑但无授权 → 403
  assert.equal((await api("tok-ed-1", "GET", "/v1/plans/pln-1")).status, 403);
  // public 密级编辑即使有授权也因密级不足被拒
  await api("tok-admin", "POST", "/v1/authorizations", {
    id: "azn-ed2",
    subjectId: "ed-2",
    scopeType: "plan",
    scopeId: "pln-1",
    validFrom: "2026-09-22T00:00:00Z",
    validUntil: "2026-09-30T00:00:00Z",
  });
  assert.equal((await api("tok-ed-2", "GET", "/v1/plans/pln-1")).status, 403);
  // restricted 编辑获得授权后可读
  await api("tok-admin", "POST", "/v1/authorizations", {
    id: "azn-ed1",
    subjectId: "ed-1",
    scopeType: "plan",
    scopeId: "pln-1",
    validFrom: "2026-09-22T00:00:00Z",
    validUntil: "2026-09-30T00:00:00Z",
  });
  const granted = await api("tok-ed-1", "GET", "/v1/plans/pln-1");
  assert.equal(granted.status, 200);
  assert.equal(granted.body.title, "某部委专访");
});

test("加密来源层：端到端加密，未授权编辑与管理员都拿不到内容", async (t) => {
  const { api, keys } = await makeApp(t);

  // 记者在客户端加密来源内容，只上传密文与明文哈希。
  const plaintext = "线人陈述：某项目招标存在围标行为。";
  const contentKey = generateContentKey();
  const ciphertext = encrypt(contentKey, plaintext);
  const created = await api("tok-jour-1", "POST", "/v1/sources", {
    id: "src-1",
    title: "围标线人",
    ciphertext,
    contentHash: sha256(plaintext),
    wrappedKeys: { "jour-1": wrapKey(keys.jour.publicKey, contentKey) },
  });
  assert.equal(created.status, 201);

  // 未授权编辑：内容 403，但元数据（哈希）可见，用于链路核验。
  assert.equal((await api("tok-ed-1", "GET", "/v1/sources/src-1")).status, 403);
  assert.equal((await api("tok-ed-1", "GET", "/v1/sources/src-1/key")).status, 403);
  const meta = await api("tok-ed-1", "GET", "/v1/sources/src-1/meta");
  assert.equal(meta.status, 200);
  assert.equal(meta.body.contentHash, sha256(plaintext));
  assert.ok(!("ciphertext" in meta.body), "元数据不得包含密文");

  // 管理员同样不能读取来源内容。
  assert.equal((await api("tok-admin", "GET", "/v1/sources/src-1")).status, 403);

  // 负责人授权：把内容密钥用编辑公钥包裹后登记。
  const grant = await api("tok-jour-1", "POST", "/v1/sources/src-1/grants", {
    granteeId: "ed-1",
    wrappedKey: wrapKey(keys.ed.publicKey, contentKey),
  });
  assert.equal(grant.status, 201);

  // 编辑取回自己的包裹密钥，本地解包并解密，哈希与承诺一致。
  const keyRes = await api("tok-ed-1", "GET", "/v1/sources/src-1/key");
  assert.equal(keyRes.status, 200);
  const unwrapped = unwrapKey(keys.ed.privateKey, keyRes.body.wrappedKey);
  const content = await api("tok-ed-1", "GET", "/v1/sources/src-1");
  assert.equal(content.status, 200);
  const decrypted = decrypt(unwrapped, content.body.ciphertext);
  assert.equal(decrypted, plaintext);
  assert.equal(sha256(decrypted), content.body.contentHash);

  // 撤销授权后编辑立即失去访问权。
  await api("tok-jour-1", "DELETE", "/v1/sources/src-1/grants/ed-1");
  assert.equal((await api("tok-ed-1", "GET", "/v1/sources/src-1")).status, 403);
});
