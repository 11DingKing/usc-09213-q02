import { iso, parseTime } from "../core/clock.mjs";
import { randomId } from "../core/crypto.mjs";
import { badRequest, conflict, forbidden, notFound } from "../core/errors.mjs";
import { isAdmin, isOwner } from "../core/auth.mjs";

// 临时变更事件：对行程/计划/笔记的修改以事件形式传播，
// 相关人必须在 confirmBy 之前确认；全部确认后立即生效，
// 逾期未确认自动失效（sweep 惰性推进，重启后照常生效）。
export function createChanges({ store, clock, audit, notify, appliers }) {
  function getOrThrow(id) {
    const change = store.state.changes[id];
    if (!change) throw notFound(`变更事件 ${id} 不存在`);
    return change;
  }

  function sweepOne(change) {
    if (change.status !== "pending") return change;
    if (clock.now() > parseTime(change.confirmBy)) {
      store.update((s) => {
        s.changes[change.id].status = "expired";
      });
      audit.record({ actor: "system", action: "change.expired", entityType: "change", entityId: change.id });
      notify.push(change.proposedBy, "change.expired", `变更 ${change.id} 已逾期未确认，自动失效`, {
        changeId: change.id,
      });
    }
    return store.state.changes[change.id];
  }

  return {
    propose(principal, input) {
      const { entityType, entityId, patch, confirmBy, requiredConfirmers, reason = "" } = input;
      if (!appliers[entityType]) throw badRequest(`不支持的变更对象类型: ${entityType}`);
      if (!patch || typeof patch !== "object") throw badRequest("变更需要 patch");
      const deadline = parseTime(confirmBy);
      if (deadline <= clock.now()) throw badRequest("confirmBy 必须晚于当前时间");
      if (!Array.isArray(requiredConfirmers) || requiredConfirmers.length === 0) {
        throw badRequest("变更需要至少一名确认人");
      }
      const id = input.id ?? randomId("chg");
      if (store.state.changes[id]) throw conflict(`变更事件 ${id} 已存在`);
      const change = {
        id,
        entityType,
        entityId,
        patch,
        reason,
        proposedBy: principal.id,
        proposedAt: iso(clock.now()),
        confirmBy: iso(deadline),
        requiredConfirmers: [...requiredConfirmers],
        confirmations: [],
        status: "pending",
      };
      store.update((s) => {
        s.changes[id] = change;
      });
      audit.record({ actor: principal.id, action: "change.proposed", entityType: "change", entityId: id });
      for (const confirmerId of requiredConfirmers) {
        notify.push(confirmerId, "change.proposed", `请在 ${change.confirmBy} 前确认变更 ${id}`, {
          changeId: id,
          entityType,
          entityId,
          confirmBy: change.confirmBy,
        });
      }
      return change;
    },

    confirm(principal, id) {
      let change = sweepOne(getOrThrow(id));
      if (change.status !== "pending") throw conflict(`变更 ${id} 当前状态为 ${change.status}，无法确认`);
      if (!change.requiredConfirmers.includes(principal.id)) throw forbidden("你不是该变更的确认人");
      if (change.confirmations.some((c) => c.principalId === principal.id)) {
        throw conflict("你已确认过该变更");
      }
      store.update((s) => {
        s.changes[id].confirmations.push({ principalId: principal.id, at: iso(clock.now()) });
      });
      audit.record({ actor: principal.id, action: "change.confirmed", entityType: "change", entityId: id });
      change = store.state.changes[id];
      const allConfirmed = change.requiredConfirmers.every((pid) =>
        change.confirmations.some((c) => c.principalId === pid),
      );
      if (allConfirmed) {
        appliers[change.entityType](change.entityId, change.patch);
        store.update((s) => {
          s.changes[id].status = "applied";
          s.changes[id].appliedAt = iso(clock.now());
        });
        audit.record({ actor: "system", action: "change.applied", entityType: "change", entityId: id });
        notify.push(change.proposedBy, "change.applied", `变更 ${id} 已获全部确认并生效`, { changeId: id });
      }
      return store.state.changes[id];
    },

    get(principal, id) {
      const change = sweepOne(getOrThrow(id));
      const involved =
        change.proposedBy === principal.id ||
        change.requiredConfirmers.includes(principal.id) ||
        isAdmin(principal);
      if (!involved) throw forbidden("你与该变更无关");
      return change;
    },

    listPending() {
      this.sweep();
      return Object.values(store.state.changes).filter((c) => c.status === "pending");
    },

    // 惰性推进所有逾期变更；启动恢复时也会调用。
    sweep() {
      for (const change of Object.values(store.state.changes)) {
        sweepOne(change);
      }
    },
  };
}
