import { iso } from "../core/clock.mjs";
import { randomId } from "../core/crypto.mjs";
import { badRequest, forbidden, notFound } from "../core/errors.mjs";
import { isAdmin } from "../core/auth.mjs";

const HOUR = 3600 * 1000;
// 风险系数：风险越高，失联后越快升级。
const RISK_FACTOR = { low: 2, medium: 1, high: 0.5 };

// 安全签到与失联升级：
// - 升级等级完全由“最近一次签到时间 + 当前时间”推导，进程重启后自然继续计时；
// - L1 提醒记者本人，L2 通知责任编辑（不含定位），L3 通知安全角色（含定位）；
// - 精确定位只对本人与安全角色开放，其他人（包括编辑）只能看到状态。
export function createSafety({ store, clock, audit, notify, journalists, principals }) {
  function thresholds(journalist) {
    const base = journalist.checkinIntervalHours * HOUR * RISK_FACTOR[journalist.riskLevel];
    return [base, base * 2, base * 4]; // [L1, L2, L3] 触发时长
  }

  function lastCheckinAt(journalist) {
    const own = store.state.checkins.filter((c) => c.journalistId === journalist.id);
    if (own.length === 0) return Date.parse(journalist.registeredAt);
    return Math.max(...own.map((c) => Date.parse(c.occurredAt)));
  }

  function levelFor(journalist, nowMs) {
    const elapsed = nowMs - lastCheckinAt(journalist);
    const [l1, l2, l3] = thresholds(journalist);
    if (elapsed >= l3) return 3;
    if (elapsed >= l2) return 2;
    if (elapsed >= l1) return 1;
    return 0;
  }

  function lastLocation(journalistId) {
    const own = store.state.checkins
      .filter((c) => c.journalistId === journalistId && c.location)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return own.length ? { ...own[own.length - 1].location, at: own[own.length - 1].occurredAt } : null;
  }

  // 评估单个记者；等级上升时记录升级并按等级定向通知。
  function evaluateOne(journalist) {
    const level = levelFor(journalist, clock.now());
    const recorded = store.state.escalations[journalist.id]?.level ?? 0;
    if (level <= recorded) return level;
    const escalation = { journalistId: journalist.id, level, at: iso(clock.now()) };
    store.update((s) => {
      s.escalations[journalist.id] = escalation;
    });
    audit.record({
      actor: "system",
      action: "safety.escalated",
      entityType: "journalist",
      entityId: journalist.id,
      detail: { level },
    });
    if (level >= 1) {
      notify.push(journalist.id, "safety.reminder", `你已 ${level} 级失联，请尽快签到`, { level });
    }
    if (level >= 2 && journalist.editorId) {
      // 编辑只收到状态，不暴露定位。
      notify.push(journalist.editorId, "safety.escalation", `记者 ${journalist.name} 失联升级至 ${level} 级`, {
        journalistId: journalist.id,
        level,
      });
    }
    if (level >= 3) {
      // 只有安全角色能收到最后已知位置。
      const location = lastLocation(journalist.id);
      for (const officer of principals.byRole("security")) {
        notify.push(officer.id, "safety.escalation", `记者 ${journalist.name} 失联 ${level} 级，最后已知位置见附件`, {
          journalistId: journalist.id,
          level,
          location,
        });
      }
    }
    return level;
  }

  return {
    checkIn(principal, input) {
      const journalistId = input.journalistId ?? principal.id;
      const journalist = journalists.get(journalistId);
      if (principal.id !== journalistId && !isAdmin(principal)) {
        throw forbidden("只能为本人签到");
      }
      const occurredAt = input.occurredAt ?? iso(clock.now());
      const checkin = {
        id: input.id ?? randomId("chk"),
        journalistId,
        occurredAt, // 事件时间（可能来自离线补录）
        receivedAt: iso(clock.now()), // 接收时间
        location: input.location ?? null,
        note: input.note ?? "",
      };
      store.update((s) => {
        s.checkins.push(checkin);
        // 签到后失联等级回落，后续重新计时。
        s.escalations[journalistId] = { journalistId, level: 0, at: iso(clock.now()) };
      });
      audit.record({ actor: principal.id, action: "safety.checkin", entityType: "journalist", entityId: journalistId });
      return checkin;
    },

    // 状态对本人、编辑、安全、管理员开放；不含精确定位。
    status(principal, journalistId) {
      const journalist = journalists.get(journalistId);
      const allowed =
        principal.id === journalistId ||
        isAdmin(principal) ||
        principal.role === "security" ||
        (principal.role === "editor" && principal.id === journalist.editorId);
      if (!allowed) throw forbidden("无权查看该记者的安全状态");
      const level = evaluateOne(journalist);
      const last = lastCheckinAt(journalist);
      return {
        journalistId,
        riskLevel: journalist.riskLevel,
        level,
        lastCheckInAt: iso(last),
        elapsedHours: Math.round(((clock.now() - last) / HOUR) * 10) / 10,
      };
    },

    // 精确定位：仅本人与安全角色。
    location(principal, journalistId) {
      journalists.get(journalistId);
      if (principal.id !== journalistId && principal.role !== "security") {
        throw forbidden("定位仅对本人与安全角色开放");
      }
      return { journalistId, location: lastLocation(journalistId) };
    },

    // 全量评估：读状态、定时任务与启动恢复时调用。
    evaluateAll() {
      const result = {};
      for (const journalist of journalists.list()) {
        result[journalist.id] = evaluateOne(journalist);
      }
      return result;
    },
  };
}
