import { Buffer } from "node:buffer";
import { Desk } from "../src/desk.mjs";
import { Store } from "../src/store.mjs";
import { Clock } from "../src/security/clock.mjs";

/**
 * 构造带可控时钟的 Desk：测试通过 advance() 推进服务器时间。
 */
export function makeDesk({ startTime = 1_000_000, dataFile = null, nodeId = "desk-test" } = {}) {
  let current = startTime;
  const store = new Store(dataFile, { nodeId });
  const clock = new Clock(() => current, 0);
  const key = Buffer.alloc(32, 7);
  const desk = new Desk(store, clock, key);
  // 预置管理员身份（部署时由引导流程创建）。
  store.data.actors.admin = { id: "admin", name: "管理员", role: "admin", clearance: 3, createdAt: 0 };
  return {
    desk,
    store: store.data,
    clock,
    key,
    get now() {
      return current;
    },
    advance(ms) {
      current += ms;
      desk.sweep();
      return current;
    },
    setTime(ms) {
      current = ms;
      desk.sweep();
    },
  };
}

export function makeActors(desk) {
  const admin = desk.data.actors.admin;
  const journalist = desk.registerActor(admin, { id: "j1", name: "记者甲", role: "journalist" });
  const journalist2 = desk.registerActor(admin, { id: "j2", name: "记者乙", role: "journalist" });
  const editor = desk.registerActor(admin, { id: "e1", name: "编辑甲", role: "editor" });
  const security = desk.registerActor(admin, { id: "s1", name: "安全值班", role: "security" });
  return { admin, journalist, journalist2, editor, security };
}
