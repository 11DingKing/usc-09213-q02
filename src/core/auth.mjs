import { forbidden, unauthorized } from "./errors.mjs";

// 密级：公开行程 < 受限采访计划 < 加密来源。
export const CLEARANCE = { public: 0, restricted: 1, confidential: 2 };

export class PrincipalRegistry {
  constructor(principals) {
    this.byToken = new Map();
    this.byId = new Map();
    for (const p of principals) {
      const principal = { clearance: "public", ...p };
      this.byToken.set(p.token, principal);
      this.byId.set(p.id, principal);
    }
  }

  authenticate(header) {
    if (!header || !header.startsWith("Bearer ")) return null;
    return this.byToken.get(header.slice("Bearer ".length)) ?? null;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  byRole(role) {
    return [...this.byId.values()].filter((p) => p.role === role);
  }
}

export function requirePrincipal(principal) {
  if (!principal) throw unauthorized();
  return principal;
}

export function requireClearance(principal, level) {
  if (CLEARANCE[principal.clearance] < CLEARANCE[level]) {
    throw forbidden(`需要 ${level} 密级`);
  }
}

export function requireRole(principal, ...roles) {
  if (!roles.includes(principal.role)) {
    throw forbidden(`需要角色: ${roles.join("/")}`);
  }
}

export const isAdmin = (p) => p.role === "admin";
export const isOwner = (p, resource) => resource.ownerId === p.id;
