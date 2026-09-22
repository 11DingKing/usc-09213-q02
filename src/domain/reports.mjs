import { iso } from "../core/clock.mjs";
import { canonical, hashObject, randomId, sha256 } from "../core/crypto.mjs";
import { badRequest, conflict, notFound } from "../core/errors.mjs";
import { requireClearance } from "../core/auth.mjs";

// 报道链路核验：
// 发布时对每条引用（计划/来源/笔记）计算哈希承诺并串联成链；
// 核验时重算哈希与链式结构。对来源只使用密文哈希与明文哈希承诺，
// 编辑无需、也无法通过核验接口取得来源内容。
function refHashOf(kind, object) {
  if (!object) return null;
  if (kind === "plan") {
    return hashObject({
      title: object.title,
      summary: object.summary,
      location: object.location,
      scheduledAt: object.scheduledAt,
      ownerId: object.ownerId,
    });
  }
  if (kind === "source") return object.ciphertextHash; // 密文哈希，无需解密
  if (kind === "note") return hashObject({ title: object.title, body: object.body, version: object.version });
  return null;
}

export function createReports({ store, clock, audit }) {
  function lookup(kind, refId) {
    if (kind === "plan") return store.state.plans[refId];
    if (kind === "source") return store.state.sources[refId];
    if (kind === "note") return store.state.notes[refId];
    return null;
  }

  function custodyOk(kind, object, journalistId) {
    if (!object) return false;
    if (kind === "source") return object.ownerId === journalistId;
    if (kind === "plan") return object.ownerId === journalistId;
    if (kind === "note") return object.ownerId === journalistId;
    return false;
  }

  return {
    publish(principal, input) {
      const { title, entries } = input;
      if (!title) throw badRequest("报道需要 title");
      if (!Array.isArray(entries) || entries.length === 0) throw badRequest("报道至少需要一条引用");
      const id = input.id ?? randomId("rpt");
      if (store.state.reports[id]) throw conflict(`报道 ${id} 已存在`);
      let prevHash = "GENESIS";
      const chained = entries.map((entry, index) => {
        const { kind, refId } = entry;
        if (!["plan", "source", "note"].includes(kind)) throw badRequest(`不支持的引用类型: ${kind}`);
        const object = lookup(kind, refId);
        if (!object) throw badRequest(`引用 ${kind}:${refId} 不存在`);
        const refHash = refHashOf(kind, object);
        const chainedEntry = {
          index,
          kind,
          refId,
          occurredAt: entry.occurredAt ?? iso(clock.now()),
          refHash,
          prevHash,
        };
        chainedEntry.entryHash = sha256(canonical(chainedEntry));
        prevHash = chainedEntry.entryHash;
        return chainedEntry;
      });
      const report = {
        id,
        journalistId: principal.id,
        title,
        entries: chained,
        chainHash: prevHash,
        publishedAt: iso(clock.now()),
      };
      store.update((s) => {
        s.reports[id] = report;
      });
      audit.record({ actor: principal.id, action: "report.published", entityType: "report", entityId: id });
      return report;
    },

    // 编辑可核验链路完整性；返回的只有哈希与布尔结论，绝不含内容。
    verify(principal, id) {
      requireClearance(principal, "restricted");
      const report = store.state.reports[id];
      if (!report) throw notFound(`报道 ${id} 不存在`);
      const checks = [];
      let prevHash = "GENESIS";
      let allOk = true;
      for (const entry of report.entries) {
        const object = lookup(entry.kind, entry.refId);
        const exists = Boolean(object);
        const currentRefHash = exists ? refHashOf(entry.kind, object) : null;
        const refIntact = exists && currentRefHash === entry.refHash;
        const { entryHash, ...unsigned } = entry; // 重算时剔除签名本身
        const expectedHash = sha256(canonical({ ...unsigned, prevHash }));
        const chainIntact = entry.prevHash === prevHash && entryHash === expectedHash;
        const custody = exists ? custodyOk(entry.kind, object, report.journalistId) : false;
        const ok = refIntact && chainIntact && custody;
        allOk = allOk && ok;
        checks.push({
          index: entry.index,
          kind: entry.kind,
          refId: entry.refId,
          refHash: entry.refHash,
          entryHash: entry.entryHash,
          exists,
          refIntact,
          chainIntact,
          custody,
          ok,
        });
        prevHash = entry.entryHash;
      }
      const chainHeadOk = prevHash === report.chainHash;
      audit.record({ actor: principal.id, action: "report.verified", entityType: "report", entityId: id });
      return { reportId: id, title: report.title, valid: allOk && chainHeadOk, chainHeadOk, checks };
    },

    get(id) {
      const report = store.state.reports[id];
      if (!report) throw notFound(`报道 ${id} 不存在`);
      return report;
    },
  };
}
