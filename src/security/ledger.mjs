import { canonicalJson, sha256Hex } from "./crypto.mjs";

/**
 * 追加式审计账本：每条目包含前一条哈希，形成可独立验证的哈希链。
 * 已提交条目不可覆盖、不可删除；业务事件时间与服务器接收时间分别记录。
 */
export class Ledger {
  constructor(clock) {
    this.clock = clock;
    this.entries = [];
  }

  get tip() {
    return this.entries.length === 0 ? null : this.entries[this.entries.length - 1].hash;
  }

  append({ type, actorId, subject, payload, eventTime, receivedAt, opId, nodeId }) {
    const index = this.entries.length;
    const received = receivedAt ?? this.clock.now();
    const body = {
      index,
      type,
      actorId,
      subject,
      payload: payload ?? null,
      eventTime: eventTime ?? null,
      receivedAt: received,
      opId: opId ?? null,
      nodeId: nodeId ?? null,
      prevHash: this.tip,
    };
    const hash = sha256Hex(canonicalJson(body));
    const entry = { ...body, hash };
    this.entries.push(entry);
    this.clock.observe(received);
    return entry;
  }

  /** 从持久化快照重放，恢复链尾与时钟水位。 */
  restore(entries) {
    this.entries = [];
    for (const stored of entries) {
      const { hash, ...body } = stored;
      const expected = sha256Hex(canonicalJson(body));
      if (hash !== expected) {
        throw new Error(`审计账本第 ${body.index} 条哈希校验失败，存储可能被篡改`);
      }
      if (body.prevHash !== this.tip) {
        throw new Error(`审计账本第 ${body.index} 条断链`);
      }
      this.entries.push(stored);
      this.clock.observe(stored.receivedAt);
    }
  }
}

/** 供编辑或外部核验方验证任意一段账本副本。 */
export function verifyChain(entries, { expectFrom = 0 } = {}) {
  let prev = null;
  for (let i = 0; i < entries.length; i += 1) {
    const stored = entries[i];
    const { hash, ...body } = stored;
    if (body.index !== expectFrom + i) {
      return { ok: false, reason: `第 ${i} 条序号不连续` };
    }
    if (body.prevHash !== prev) {
      return { ok: false, reason: `第 ${i} 条断链` };
    }
    if (sha256Hex(canonicalJson(body)) !== hash) {
      return { ok: false, reason: `第 ${i} 条哈希不匹配` };
    }
    prev = hash;
  }
  return { ok: true, tip: prev };
}
