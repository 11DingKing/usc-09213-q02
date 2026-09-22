import fs from "node:fs";
import path from "node:path";

const initialState = () => ({
  journalists: {},
  itineraries: {},
  plans: {},
  sources: {},
  changes: {},
  checkins: [],
  escalations: {},
  advances: {},
  receipts: {},
  authorizations: {},
  notes: {},
  conflicts: {},
  reports: {},
  notifications: {},
  idempotency: {},
  meta: { version: 1 },
});

// 写穿式 JSON 快照存储：每次变更原子落盘（临时文件 + rename），
// 重启后从快照恢复，所有计时均由持久化时间戳派生。
export class Store {
  constructor(filePath = null) {
    this.filePath = filePath;
    if (filePath && fs.existsSync(filePath)) {
      this._state = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } else {
      this._state = initialState();
    }
  }

  get state() {
    return this._state;
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  update(mutator) {
    const result = mutator(this._state);
    this.save();
    return result;
  }
}
