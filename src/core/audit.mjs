import fs from "node:fs";
import path from "node:path";
import { canonical, sha256 } from "./crypto.mjs";
import { iso } from "./clock.mjs";

// 追加式审计日志：哈希链串联，任何条目都不允许覆盖修改，
// 纠错只能以新条目追加。filePath 为 null 时仅驻留内存（测试用）。
export class AuditLog {
  constructor(filePath, clock) {
    this.filePath = filePath;
    this.clock = clock;
    this.entries = [];
    this.tailHash = "GENESIS";
    if (filePath && fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line);
        this.entries.push(entry);
        this.tailHash = entry.hash;
      }
    }
  }

  record({ actor, action, entityType, entityId, detail = null }) {
    const entry = {
      seq: this.entries.length + 1,
      at: iso(this.clock.now()),
      actor,
      action,
      entityType,
      entityId,
      detail,
      prevHash: this.tailHash,
    };
    entry.hash = sha256(canonical(entry));
    this.entries.push(entry);
    this.tailHash = entry.hash;
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    }
    return entry;
  }

  // 校验哈希链完整性，发现篡改时返回断裂位置。
  verify() {
    let prevHash = "GENESIS";
    for (const entry of this.entries) {
      const { hash, ...rest } = entry;
      if (rest.prevHash !== prevHash) {
        return { valid: false, brokenAt: entry.seq, reason: "prevHash 不连续" };
      }
      if (sha256(canonical(rest)) !== hash) {
        return { valid: false, brokenAt: entry.seq, reason: "条目哈希不匹配" };
      }
      prevHash = hash;
    }
    return { valid: true, length: this.entries.length };
  }

  query(filter = {}) {
    return this.entries.filter((e) => {
      if (filter.entityType && e.entityType !== filter.entityType) return false;
      if (filter.entityId && e.entityId !== filter.entityId) return false;
      if (filter.action && e.action !== filter.action) return false;
      return true;
    });
  }
}
