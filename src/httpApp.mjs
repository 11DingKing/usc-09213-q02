import http from "node:http";
import { AppError, unauthorized } from "./errors.mjs";

/**
 * 身份由调用方提供的稳定标识表示（见 docs/domain.md）。
 * 受控运行环境中应由网关/mTLS 完成鉴权后注入 x-actor-id，
 * 本服务不直接面对公网。
 */
export function createServer(desk) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const route = matchRoute(request.method, url.pathname);

      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { status: "ok" });
      }
      if (!route) return send(response, 404, { error: { code: "not_found", message: "路由不存在" } });

      const actorId = request.headers["x-actor-id"];
      if (!actorId) throw unauthorized("缺少 x-actor-id 头");
      const actor = desk.data.actors[actorId];
      if (!actor) throw unauthorized("身份不存在或已注销");

      const body = await readJson(request);
      const result = await route.handler(desk, actor, { body, params: route.params, query: url.searchParams });
      desk.save();
      return send(response, result.status ?? 200, result.body);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return send(response, 400, { error: { code: "bad_json", message: "请求体不是合法 JSON" } });
      }
      if (error instanceof AppError) {
        return send(response, error.status, {
          error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
        });
      }
      return send(response, 500, { error: { code: "internal", message: error.message } });
    }
  });
}

const routes = [];
function addRoute(method, pattern, handler) {
  routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, "(?<$1>[^/]+)")}$`), handler });
}
function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match) return { handler: route.handler, params: match.groups ?? {} };
  }
  return null;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

// ── 路由表 ──────────────────────────────────────────────────────

addRoute("POST", "/admin/actors", (desk, actor, { body }) => ({
  status: 201,
  body: desk.registerActor(actor, body),
}));
addRoute("POST", "/admin/grants", (desk, actor, { body }) => ({
  status: 201,
  body: desk.issueGrant(actor, body),
}));
addRoute("POST", "/records", (desk, actor, { body }) => ({
  status: 201,
  body: desk.createRecord(actor, body),
}));
addRoute("PATCH", "/records/:id", (desk, actor, { body, params }) => ({
  body: desk.updateRecord(actor, { id: params.id, ...body }),
}));
addRoute("GET", "/records", (desk, actor, { query }) => ({
  body: desk.listRecords(actor, { tier: query.has("tier") ? Number(query.get("tier")) : null }),
}));
addRoute("GET", "/records/:id", (desk, actor, { params }) => ({
  body: desk.readRecord(actor, params.id),
}));
addRoute("GET", "/records/:id/verify", (desk, actor, { params }) => ({
  body: desk.verifyRecord(actor, params.id),
}));

addRoute("POST", "/events", (desk, actor, { body }) => ({
  status: 201,
  body: desk.publishEvent(actor, body),
}));
addRoute("POST", "/events/:id/ack", (desk, actor, { params }) => ({
  body: desk.acknowledgeEvent(actor, params.id),
}));
addRoute("GET", "/events", (desk, actor) => ({ body: desk.listEvents(actor) }));

addRoute("POST", "/safety/plans", (desk, actor, { body }) => ({
  status: 201,
  body: desk.setSafetyPlan(actor, body),
}));
addRoute("POST", "/safety/checkins", (desk, actor, { body }) => ({
  body: desk.checkin(actor, body),
}));
addRoute("GET", "/safety/status", (desk, actor) => ({ body: desk.safetyStatus(actor) }));

addRoute("POST", "/finance/advances", (desk, actor, { body }) => ({
  status: 201,
  body: desk.createAdvance(actor, body),
}));
addRoute("POST", "/finance/receipts", (desk, actor, { body }) => ({
  status: 201,
  body: desk.submitReceipt(actor, body),
}));
addRoute("GET", "/finance/advances/:id", (desk, actor, { params }) => ({
  body: desk.getAdvance(actor, params.id),
}));

addRoute("POST", "/sync", (desk, actor, { body }) => ({
  body: desk.sync(actor, body.ops ?? []),
}));

addRoute("GET", "/audit", (desk, actor, { query }) => {
  if (!["admin", "security"].includes(actor.role)) {
    throw new AppError(403, "forbidden", "只有管理员与安全岗可查看审计账本");
  }
  const subject = query.get("subject");
  const entries = desk.data.ledger
    .filter((entry) => !subject || entry.subject === subject)
    .map(({ index, type, actorId, subject: s, eventTime, receivedAt, hash, prevHash, opId }) => ({
      index, type, actorId, subject: s, eventTime, receivedAt, hash, prevHash, opId,
    }));
  return { body: entries };
});
