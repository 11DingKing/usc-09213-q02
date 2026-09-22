import { iso } from "../core/clock.mjs";
import { randomId } from "../core/crypto.mjs";
import { badRequest, conflict, notFound } from "../core/errors.mjs";
import { requireRole } from "../core/auth.mjs";

// 公开行程层：任何已认证成员可读，记者/编辑可写。
// 行程内容的临时变更不直接改写，而是通过变更事件（changes）传播并确认。
export function createItineraries({ store, clock, audit }) {
  return {
    create(principal, input) {
      requireRole(principal, "journalist", "editor", "admin");
      const { city, venue, startAt, endAt, summary } = input;
      if (!city || !startAt || !endAt) throw badRequest("行程需要 city/startAt/endAt");
      const id = input.id ?? randomId("itn");
      if (store.state.itineraries[id]) throw conflict(`行程 ${id} 已存在`);
      const itinerary = {
        id,
        layer: "public",
        ownerId: input.ownerId ?? principal.id,
        city,
        venue: venue ?? null,
        startAt,
        endAt,
        summary: summary ?? "",
        createdAt: iso(clock.now()),
      };
      store.update((s) => {
        s.itineraries[id] = itinerary;
      });
      audit.record({ actor: principal.id, action: "itinerary.create", entityType: "itinerary", entityId: id });
      return itinerary;
    },

    get(id) {
      const it = store.state.itineraries[id];
      if (!it) throw notFound(`行程 ${id} 不存在`);
      return it;
    },

    list(filter = {}) {
      return Object.values(store.state.itineraries).filter(
        (it) => !filter.journalistId || it.ownerId === filter.journalistId,
      );
    },

    // 仅供变更事件在全员确认后应用补丁。
    applyPatch(id, patch) {
      const allowed = ["city", "venue", "startAt", "endAt", "summary"];
      return store.update((s) => {
        const it = s.itineraries[id];
        if (!it) throw notFound(`行程 ${id} 不存在`);
        for (const key of allowed) {
          if (key in patch) it[key] = patch[key];
        }
        return it;
      });
    },
  };
}
