import { iso, parseTime } from "../core/clock.mjs";
import { randomId } from "../core/crypto.mjs";
import { badRequest, conflict, forbidden, notFound } from "../core/errors.mjs";
import { isAdmin } from "../core/auth.mjs";

// 采访授权：授予某成员在 [validFrom, validUntil] 内访问某个受限对象。
// 到期自动收紧：hasAccess 每次实时判定有效期；sweep 负责把过期授权
// 落盘为 expired 并写审计，进程重启后照常执行。
export function createAuthorizations({ store, clock, audit }) {
  function isCurrentlyActive(auth, nowMs) {
    return (
      auth.status === "active" &&
      parseTime(auth.validFrom) <= nowMs &&
      nowMs <= parseTime(auth.validUntil)
    );
  }

  return {
    grant(principal, input) {
      const { subjectId, scopeType, scopeId, validFrom, validUntil } = input;
      if (!subjectId || !scopeType || !scopeId) throw badRequest("授权需要 subjectId/scopeType/scopeId");
      if (!validFrom || !validUntil) throw badRequest("授权需要 validFrom 与 validUntil");
      if (parseTime(validUntil) <= parseTime(validFrom)) throw badRequest("validUntil 必须晚于 validFrom");
      // 只有管理员或对象负责人可以授权（负责人判定由调用方先行完成时传 ownerOk）。
      if (!isAdmin(principal) && !input.ownerOk) throw forbidden("只有管理员或对象负责人可以授予采访授权");
      const id = input.id ?? randomId("azn");
      if (store.state.authorizations[id]) throw conflict(`授权 ${id} 已存在`);
      const auth = {
        id,
        subjectId,
        scopeType,
        scopeId,
        grantedBy: principal.id,
        validFrom: iso(parseTime(validFrom)),
        validUntil: iso(parseTime(validUntil)),
        status: "active",
        createdAt: iso(clock.now()),
      };
      store.update((s) => {
        s.authorizations[id] = auth;
      });
      audit.record({
        actor: principal.id,
        action: "authorization.granted",
        entityType: "authorization",
        entityId: id,
        detail: { subjectId, scopeType, scopeId, validUntil: auth.validUntil },
      });
      return auth;
    },

    revoke(principal, id) {
      const auth = store.state.authorizations[id];
      if (!auth) throw notFound(`授权 ${id} 不存在`);
      if (!isAdmin(principal) && auth.grantedBy !== principal.id) throw forbidden("只有授予人或管理员可以撤销");
      if (auth.status !== "active") throw conflict(`授权状态为 ${auth.status}`);
      store.update((s) => {
        s.authorizations[id].status = "revoked";
        s.authorizations[id].revokedAt = iso(clock.now());
      });
      audit.record({ actor: principal.id, action: "authorization.revoked", entityType: "authorization", entityId: id });
      return store.state.authorizations[id];
    },

    // 实时判定：超过 validUntil 即视为无权（自动收紧），并惰性落盘。
    hasAccess(subjectId, scopeType, scopeId) {
      const now = clock.now();
      return Object.values(store.state.authorizations).some((auth) => {
        if (auth.subjectId !== subjectId || auth.scopeType !== scopeType || auth.scopeId !== scopeId) return false;
        if (auth.status === "active" && now > parseTime(auth.validUntil)) this.expire(auth.id);
        return isCurrentlyActive(store.state.authorizations[auth.id], now);
      });
    },

    expire(id) {
      const auth = store.state.authorizations[id];
      if (!auth || auth.status !== "active") return;
      store.update((s) => {
        s.authorizations[id].status = "expired";
        s.authorizations[id].expiredAt = iso(clock.now());
      });
      audit.record({ actor: "system", action: "authorization.expired", entityType: "authorization", entityId: id });
    },

    get(id) {
      const auth = store.state.authorizations[id];
      if (!auth) throw notFound(`授权 ${id} 不存在`);
      return auth;
    },

    // 启动恢复与定时任务调用：把所有过期授权落盘。
    sweep() {
      const now = clock.now();
      for (const auth of Object.values(store.state.authorizations)) {
        if (auth.status === "active" && now > parseTime(auth.validUntil)) this.expire(auth.id);
      }
    },
  };
}
