import fs from "node:fs";
import path from "node:path";

function emptyData(nodeId) {
  return {
    meta: { seq: 0, nodeId },
    actors: {},
    grants: {},
    records: {},
    events: {},
    trips: {},
    checkins: [],
    advances: {},
    receipts: {},
    idempotency: {},
    seenOps: {},
    opResults: {},
    ledger: [],
  };
}

/**
 * 极简 JSON 快照存储：独立运行无需外部数据库。
 * 写入采用临时文件 + rename，避免崩溃时留下半截文件。
 */
export class Store {
  constructor(filePath = null, { nodeId = "desk" } = {}) {
    this.filePath = filePath;
    if (filePath && fs.existsSync(filePath)) {
      this.data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } else {
      this.data = emptyData(nodeId);
    }
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.filePath);
  }
}
