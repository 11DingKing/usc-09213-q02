import { iso } from "../core/clock.mjs";
import { randomId } from "../core/crypto.mjs";
import { notFound } from "../core/errors.mjs";

// 站内通知：升级、变更、授权等事件通过它传播给相关人。
// data 由调用方按接收者密级过滤后再放入（例如定位只发给安全角色）。
export function createNotifications({ store, clock }) {
  return {
    push(to, kind, message, data = null) {
      const notification = {
        id: randomId("ntf"),
        to,
        kind,
        message,
        data,
        at: iso(clock.now()),
        readAt: null,
      };
      store.update((s) => {
        s.notifications[notification.id] = notification;
      });
      return notification;
    },

    listFor(principalId) {
      return Object.values(store.state.notifications)
        .filter((n) => n.to === principalId)
        .sort((a, b) => a.at.localeCompare(b.at));
    },

    markRead(principal, id) {
      const n = store.state.notifications[id];
      if (!n || n.to !== principal.id) throw notFound("通知不存在");
      return store.update((s) => {
        s.notifications[id].readAt = iso(clock.now());
        return s.notifications[id];
      });
    },
  };
}
