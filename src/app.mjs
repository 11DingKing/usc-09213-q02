import http from "node:http";
import path from "node:path";
import { SystemClock } from "./core/clock.mjs";
import { AuditLog } from "./core/audit.mjs";
import { Store } from "./core/store.mjs";
import { PrincipalRegistry, requirePrincipal, requireRole } from "./core/auth.mjs";
import { HttpError } from "./core/errors.mjs";
import { Router } from "./http/router.mjs";
import { readJson, send } from "./http/helpers.mjs";
import { createNotifications } from "./domain/notifications.mjs";
import { createJournalists } from "./domain/journalists.mjs";
import { createItineraries } from "./domain/itineraries.mjs";
import { createPlans } from "./domain/plans.mjs";
import { createSources } from "./domain/sources.mjs";
import { createChanges } from "./domain/changes.mjs";
import { createSafety } from "./domain/safety.mjs";
import { createExpenses } from "./domain/expenses.mjs";
import { createAuthorizations } from "./domain/authorizations.mjs";
import { createNotes } from "./domain/notes.mjs";
import { createReports } from "./domain/reports.mjs";

// 开发环境默认成员（仅用于本地运行；生产环境应通过 DESK_CONFIG 注入）。
export const defaultConfig = {
  principals: [
    { id: "jour-1", name: "记者甲", role: "journalist", clearance: "confidential", token: "tok-jour-1" },
    { id: "ed-1", name: "编辑乙", role: "editor", clearance: "restricted", token: "tok-ed-1" },
    { id: "ed-2", name: "见习编辑", role: "editor", clearance: "public", token: "tok-ed-2" },
    { id: "sec-1", name: "安全官", role: "security", clearance: "confidential", token: "tok-sec-1" },
    { id: "fin-1", name: "财务", role: "finance", clearance: "public", token: "tok-fin-1" },
    { id: "admin-1", name: "管理员", role: "admin", clearance: "confidential", token: "tok-admin" },
  ],
};

export function createApp(options = {}) {
  const clock = options.clock ?? new SystemClock();
  const config = options.config ?? defaultConfig;
  const dataDir = options.dataDir ?? null;

  const store = new Store(dataDir ? path.join(dataDir, "state.json") : null);
  const audit = new AuditLog(dataDir ? path.join(dataDir, "audit.log") : null, clock);
  const principals = new PrincipalRegistry(config.principals);
  const notify = createNotifications({ store, clock });

  const authorizations = createAuthorizations({ store, clock, audit });
  const journalists = createJournalists({ store, clock, audit });
  const itineraries = createItineraries({ store, clock, audit });
  const plans = createPlans({ store, clock, audit, authorizations });
  const sources = createSources({ store, clock, audit, principals });
  const notes = createNotes({ store, clock, audit });
  const changes = createChanges({
    store,
    clock,
    audit,
    notify,
    appliers: {
      itinerary: (id, patch) => itineraries.applyPatch(id, patch),
      plan: (id, patch) => plans.applyPatch(id, patch),
    },
  });
  const safety = createSafety({ store, clock, audit, notify, journalists, principals });
  const expenses = createExpenses({ store, clock, audit });
  const reports = createReports({ store, clock, audit });

  // 启动恢复：所有计时都从持久化时间戳派生，
  // 重启后立即按当前时间推进逾期变更、过期授权与失联升级。
  function recover() {
    changes.sweep();
    authorizations.sweep();
    safety.evaluateAll();
  }
  recover();

  const router = new Router();
  const r = (method, pattern, handler) => router.add(method, pattern, handler);

  // ---- 记者档案 ----
  r("POST", "/v1/journalists", async (p, req) => send(req.res, 201, journalists.register(p, await readJson(req))));
  r("GET", "/v1/journalists", async (p, req) => send(req.res, 200, journalists.list()));

  // ---- 公开行程层 ----
  r("POST", "/v1/itineraries", async (p, req) => send(req.res, 201, itineraries.create(p, await readJson(req))));
  r("GET", "/v1/itineraries", async (p, req) => send(req.res, 200, itineraries.list(req.query)));
  r("GET", "/v1/itineraries/:id", async (p, req) => send(req.res, 200, itineraries.get(req.params.id)));

  // ---- 受限采访计划层 ----
  r("POST", "/v1/plans", async (p, req) => send(req.res, 201, plans.create(p, await readJson(req))));
  r("GET", "/v1/plans", async (p, req) => send(req.res, 200, plans.list(p)));
  r("GET", "/v1/plans/:id", async (p, req) => send(req.res, 200, plans.get(p, req.params.id)));

  // ---- 加密来源层 ----
  r("POST", "/v1/sources", async (p, req) => send(req.res, 201, sources.create(p, await readJson(req))));
  r("GET", "/v1/sources/:id", async (p, req) => send(req.res, 200, sources.content(p, req.params.id)));
  r("GET", "/v1/sources/:id/meta", async (p, req) => send(req.res, 200, sources.meta(p, req.params.id)));
  r("GET", "/v1/sources/:id/key", async (p, req) => send(req.res, 200, sources.wrappedKeyFor(p, req.params.id)));
  r("POST", "/v1/sources/:id/grants", async (p, req) =>
    send(req.res, 201, sources.grant(p, req.params.id, await readJson(req))),
  );
  r("DELETE", "/v1/sources/:id/grants/:pid", async (p, req) =>
    send(req.res, 200, sources.revoke(p, req.params.id, req.params.pid)),
  );

  // ---- 临时变更事件 ----
  r("POST", "/v1/changes", async (p, req) => send(req.res, 201, changes.propose(p, await readJson(req))));
  r("POST", "/v1/changes/:id/confirm", async (p, req) => send(req.res, 200, changes.confirm(p, req.params.id)));
  r("GET", "/v1/changes/:id", async (p, req) => send(req.res, 200, changes.get(p, req.params.id)));

  // ---- 安全签到与失联升级 ----
  r("POST", "/v1/safety/checkins", async (p, req) => send(req.res, 201, safety.checkIn(p, await readJson(req))));
  r("GET", "/v1/safety/:journalistId", async (p, req) => send(req.res, 200, safety.status(p, req.params.journalistId)));
  r("GET", "/v1/safety/:journalistId/location", async (p, req) =>
    send(req.res, 200, safety.location(p, req.params.journalistId)),
  );
  r("POST", "/v1/safety/evaluate", async (p, req) => {
    requireRole(p, "admin", "security");
    return send(req.res, 200, safety.evaluateAll());
  });

  // ---- 费用预支与核销 ----
  r("POST", "/v1/expenses/advances", async (p, req) => {
    const { advance, idempotent } = expenses.requestAdvance(p, await readJson(req));
    return send(req.res, idempotent ? 200 : 201, advance);
  });
  r("POST", "/v1/expenses/advances/:id/approve", async (p, req) =>
    send(req.res, 200, expenses.approveAdvance(p, req.params.id)),
  );
  r("POST", "/v1/expenses/advances/:id/disburse", async (p, req) =>
    send(req.res, 200, expenses.disburseAdvance(p, req.params.id)),
  );
  r("POST", "/v1/expenses/advances/:id/receipts", async (p, req) =>
    send(req.res, 201, expenses.submitReceipt(p, req.params.id, await readJson(req))),
  );
  r("POST", "/v1/expenses/receipts/:id/reconcile", async (p, req) =>
    send(req.res, 200, expenses.reconcileReceipt(p, req.params.id)),
  );
  r("GET", "/v1/expenses/advances/:id", async (p, req) =>
    send(req.res, 200, expenses.advanceStatus(p, req.params.id)),
  );

  // ---- 采访授权 ----
  r("POST", "/v1/authorizations", async (p, req) => send(req.res, 201, authorizations.grant(p, await readJson(req))));
  r("POST", "/v1/authorizations/:id/revoke", async (p, req) =>
    send(req.res, 200, authorizations.revoke(p, req.params.id)),
  );
  r("GET", "/v1/authorizations/:id", async (p, req) => send(req.res, 200, authorizations.get(req.params.id)));

  // ---- 现场笔记与离线回传 ----
  r("POST", "/v1/notes", async (p, req) => send(req.res, 201, notes.create(p, await readJson(req))));
  r("GET", "/v1/notes/:id", async (p, req) => send(req.res, 200, notes.get(p, req.params.id)));
  r("PATCH", "/v1/notes/:id", async (p, req) => send(req.res, 200, notes.update(p, req.params.id, await readJson(req))));
  r("POST", "/v1/offline/sync", async (p, req) => {
    const body = await readJson(req);
    return send(req.res, 200, notes.syncBatch(p, body.items));
  });
  r("GET", "/v1/offline/conflicts", async (p, req) => send(req.res, 200, notes.listConflicts(p)));
  r("POST", "/v1/offline/conflicts/:id/resolve", async (p, req) =>
    send(req.res, 200, notes.resolveConflict(p, req.params.id, await readJson(req))),
  );

  // ---- 报道链路核验 ----
  r("POST", "/v1/reports", async (p, req) => send(req.res, 201, reports.publish(p, await readJson(req))));
  r("GET", "/v1/reports/:id/verify", async (p, req) => send(req.res, 200, reports.verify(p, req.params.id)));

  // ---- 通知 ----
  r("GET", "/v1/notifications", async (p, req) => send(req.res, 200, notify.listFor(p.id)));
  r("POST", "/v1/notifications/:id/read", async (p, req) =>
    send(req.res, 200, notify.markRead(p, req.params.id)),
  );

  // ---- 审计 ----
  r("GET", "/v1/audit", async (p, req) => {
    requireRole(p, "admin", "security");
    return send(req.res, 200, audit.query(req.query));
  });
  r("GET", "/v1/audit/verify", async (p, req) => {
    requireRole(p, "admin", "security");
    return send(req.res, 200, audit.verify());
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/health") {
        return send(res, 200, { status: "ok" });
      }
      if (!url.pathname.startsWith("/v1/")) {
        return send(res, 404, { error: { code: "not_found", message: "路由不存在" } });
      }
      const principal = principals.authenticate(req.headers.authorization);
      requirePrincipal(principal);
      const { handler, params } = router.match(req.method, url.pathname);
      req.params = params;
      req.query = Object.fromEntries(url.searchParams);
      req.res = res;
      return await handler(principal, req);
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      }
      return send(res, 500, { error: { code: "internal", message: "服务内部错误" } });
    }
  });

  return {
    server,
    clock,
    store,
    audit,
    recover,
    services: { journalists, itineraries, plans, sources, changes, safety, expenses, authorizations, notes, reports, notify },
  };
}
