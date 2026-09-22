import { iso } from "../core/clock.mjs";
import { randomId } from "../core/crypto.mjs";
import { badRequest, conflict, forbidden, notFound } from "../core/errors.mjs";
import { isAdmin, isOwner, requireClearance, requireRole } from "../core/auth.mjs";

// 受限采访计划层：读需要 restricted 密级，且必须是
// 负责人 / 管理员 / 持有有效采访授权 三者之一。
// 授权到期在每次访问时实时判定（自动收紧），无需等待后台任务。
export function createPlans({ store, clock, audit, authorizations }) {
  function assertAccess(principal, plan) {
    requireClearance(principal, "restricted");
    if (isAdmin(principal) || isOwner(principal, plan)) return;
    if (authorizations.hasAccess(principal.id, "plan", plan.id)) return;
    throw forbidden("需要该采访计划的有效授权");
  }

  return {
    create(principal, input) {
      requireRole(principal, "journalist", "editor", "admin");
      const { title, summary, location, scheduledAt } = input;
      if (!title || !scheduledAt) throw badRequest("采访计划需要 title 与 scheduledAt");
      const id = input.id ?? randomId("pln");
      if (store.state.plans[id]) throw conflict(`采访计划 ${id} 已存在`);
      const plan = {
        id,
        layer: "restricted",
        ownerId: input.ownerId ?? principal.id,
        title,
        summary: summary ?? "",
        location: location ?? null,
        scheduledAt,
        createdAt: iso(clock.now()),
      };
      store.update((s) => {
        s.plans[id] = plan;
      });
      audit.record({ actor: principal.id, action: "plan.create", entityType: "plan", entityId: id });
      return plan;
    },

    get(principal, id) {
      const plan = store.state.plans[id];
      if (!plan) throw notFound(`采访计划 ${id} 不存在`);
      assertAccess(principal, plan);
      return plan;
    },

    list(principal) {
      requireClearance(principal, "restricted");
      return Object.values(store.state.plans).filter((plan) => {
        if (isAdmin(principal) || isOwner(principal, plan)) return true;
        return authorizations.hasAccess(principal.id, "plan", plan.id);
      });
    },

    applyPatch(id, patch) {
      const allowed = ["title", "summary", "location", "scheduledAt"];
      return store.update((s) => {
        const plan = s.plans[id];
        if (!plan) throw notFound(`采访计划 ${id} 不存在`);
        for (const key of allowed) {
          if (key in patch) plan[key] = patch[key];
        }
        return plan;
      });
    },
  };
}
