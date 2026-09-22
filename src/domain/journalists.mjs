import { iso } from "../core/clock.mjs";
import { badRequest, conflict, notFound } from "../core/errors.mjs";
import { requireRole } from "../core/auth.mjs";

const RISK_LEVELS = ["low", "medium", "high"];

// 记者档案：风险等级与签到间隔驱动失联升级策略。
// 业务身份使用调用方提供的稳定标识（id 字段）。
export function createJournalists({ store, clock, audit }) {
  return {
    register(principal, input) {
      requireRole(principal, "admin");
      const { id, name, desk = "beijing", riskLevel = "medium", checkinIntervalHours = 6, editorId } = input;
      if (!id || !name) throw badRequest("记者档案需要 id 与 name");
      if (!RISK_LEVELS.includes(riskLevel)) throw badRequest(`riskLevel 必须是 ${RISK_LEVELS.join("/")}`);
      if (store.state.journalists[id]) throw conflict(`记者 ${id} 已存在`);
      const journalist = {
        id,
        name,
        desk,
        riskLevel,
        checkinIntervalHours,
        editorId: editorId ?? null,
        registeredAt: iso(clock.now()),
      };
      store.update((s) => {
        s.journalists[id] = journalist;
      });
      audit.record({ actor: principal.id, action: "journalist.register", entityType: "journalist", entityId: id });
      return journalist;
    },

    get(id) {
      const j = store.state.journalists[id];
      if (!j) throw notFound(`记者 ${id} 不存在`);
      return j;
    },

    list() {
      return Object.values(store.state.journalists);
    },
  };
}
