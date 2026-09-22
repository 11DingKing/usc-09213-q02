import fs from "node:fs";
import path from "node:path";
import { createServer as createHttpServer } from "./httpApp.mjs";
import { Store } from "./store.mjs";
import { Desk } from "./desk.mjs";
import { Clock } from "./security/clock.mjs";
import { dataKeyFromBase64, generateDataKey } from "./security/crypto.mjs";

/**
 * 独立运行装配：
 * - DESK_DATA_FILE  数据快照路径（默认 data/desk.json）
 * - DESK_DATA_KEY   base64 编码的 32 字节主密钥；未提供时使用 data/master.key
 *                   （首次启动自动生成，权限 0600）。生产环境应通过密钥管理注入。
 */
export function bootstrap({ dataFile = process.env.DESK_DATA_FILE ?? null, now = () => Date.now() } = {}) {
  const dataDir = dataFile ? path.dirname(dataFile) : path.join(process.cwd(), "data");
  const resolvedDataFile = dataFile ?? path.join(dataDir, "desk.json");

  let dataKey;
  if (process.env.DESK_DATA_KEY) {
    dataKey = dataKeyFromBase64(process.env.DESK_DATA_KEY);
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    const keyFile = path.join(dataDir, "master.key");
    if (fs.existsSync(keyFile)) {
      dataKey = dataKeyFromBase64(fs.readFileSync(keyFile, "utf8").trim());
    } else {
      dataKey = generateDataKey();
      fs.writeFileSync(keyFile, dataKey.toString("base64"), { mode: 0o600 });
    }
  }

  const store = new Store(resolvedDataFile);
  const clock = new Clock(now, 0);
  const desk = new Desk(store, clock, dataKey);

  // 冷启动引导：身份表为空时，从环境变量创建首个管理员，之后不再生效。
  if (Object.keys(store.data.actors).length === 0) {
    const bootstrapId = process.env.DESK_BOOTSTRAP_ADMIN ?? "admin";
    store.data.actors[bootstrapId] = {
      id: bootstrapId,
      name: process.env.DESK_BOOTSTRAP_ADMIN_NAME ?? "初始管理员",
      role: "admin",
      clearance: 3,
      createdAt: clock.now(),
    };
    desk.noteBootstrap(bootstrapId);
    store.save();
  }

  return { desk, store, clock, dataFile: resolvedDataFile };
}

export function createServer(options = {}) {
  const { desk } = bootstrap(options);
  return createHttpServer(desk);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 8000);
  const host = process.env.HOST ?? "127.0.0.1";
  const { desk, dataFile } = bootstrap();

  // 后台按服务器时钟推进确认期限与失联升级，即使没有请求到达也会落盘。
  const sweepMs = Number(process.env.DESK_SWEEP_MS ?? 30_000);
  const sweeper = setInterval(() => {
    desk.sweep();
    desk.save();
  }, sweepMs);
  sweeper.unref();

  createHttpServer(desk).listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`驻外记者协作服务已启动: http://${host}:${port}，数据文件 ${dataFile}`);
  });
}
