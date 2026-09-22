import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { ManualClock } from "../src/core/clock.mjs";
import { generateKeyPair } from "../src/core/crypto.mjs";

export const T0 = Date.parse("2026-09-22T00:00:00.000Z");
export const HOUR = 3600 * 1000;

// 每个测试一套独立数据目录 + 手动时钟 + 带 RSA 密钥对的成员配置。
export async function makeApp(t, { startAt = T0, persist = true } = {}) {
  const clock = new ManualClock(startAt);
  const jourKeys = generateKeyPair();
  const edKeys = generateKeyPair();
  const config = {
    principals: [
      { id: "jour-1", name: "记者甲", role: "journalist", clearance: "confidential", token: "tok-jour-1", publicKey: jourKeys.publicKey },
      { id: "ed-1", name: "编辑乙", role: "editor", clearance: "restricted", token: "tok-ed-1", publicKey: edKeys.publicKey },
      { id: "ed-2", name: "见习编辑", role: "editor", clearance: "public", token: "tok-ed-2" },
      { id: "sec-1", name: "安全官", role: "security", clearance: "confidential", token: "tok-sec-1" },
      { id: "fin-1", name: "财务", role: "finance", clearance: "public", token: "tok-fin-1" },
      { id: "admin-1", name: "管理员", role: "admin", clearance: "confidential", token: "tok-admin" },
    ],
  };
  const dataDir = persist ? await fs.mkdtemp(path.join(os.tmpdir(), "desk-test-")) : null;
  if (dataDir) t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const app = createApp({ dataDir, clock, config });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  async function api(token, method, pathName, body) {
    const response = await fetch(base + pathName, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  return { app, api, clock, dataDir, config, keys: { jour: jourKeys, ed: edKeys } };
}

// 常用前置：注册一名中风险记者，责任编辑为 ed-1。
export async function seedJournalist(api, overrides = {}) {
  const res = await api("tok-admin", "POST", "/v1/journalists", {
    id: "jour-1",
    name: "记者甲",
    riskLevel: "medium",
    checkinIntervalHours: 6,
    editorId: "ed-1",
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`注册记者失败: ${JSON.stringify(res.body)}`);
  return res.body;
}
