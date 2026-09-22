import { iso } from "../core/clock.mjs";
import { randomId } from "../core/crypto.mjs";
import { badRequest, conflict, forbidden, notFound } from "../core/errors.mjs";
import { isAdmin, requireRole } from "../core/auth.mjs";

// 费用预支与票据核销：
// - 预支按 idempotencyKey 幂等，重复提交返回同一张单；
// - 票据号在同一记者名下唯一，防止重复报销；
// - 核销一次性且累计不得超过预支额。
export function createExpenses({ store, clock, audit }) {
  function getAdvance(id) {
    const a = store.state.advances[id];
    if (!a) throw notFound(`预支单 ${id} 不存在`);
    return a;
  }

  function reconciledTotal(advanceId) {
    return Object.values(store.state.receipts)
      .filter((r) => r.advanceId === advanceId && r.status === "reconciled")
      .reduce((sum, r) => sum + r.amount, 0);
  }

  return {
    requestAdvance(principal, input) {
      requireRole(principal, "journalist");
      const { idempotencyKey, amount, currency = "CNY", purpose } = input;
      if (!idempotencyKey) throw badRequest("预支需要 idempotencyKey 以防重复");
      if (!(amount > 0)) throw badRequest("预支金额必须为正数");
      if (!purpose) throw badRequest("预支需要用途说明");
      const idemKey = `advance:${principal.id}:${idempotencyKey}`;
      const existingId = store.state.idempotency[idemKey];
      if (existingId) {
        // 幂等命中：返回原单，不产生新记录。
        return { advance: store.state.advances[existingId], idempotent: true };
      }
      const id = input.id ?? randomId("adv");
      if (store.state.advances[id]) throw conflict(`预支单 ${id} 已存在`);
      const advance = {
        id,
        journalistId: principal.id,
        amount,
        currency,
        purpose,
        status: "requested",
        requestedAt: iso(clock.now()),
      };
      store.update((s) => {
        s.advances[id] = advance;
        s.idempotency[idemKey] = id;
      });
      audit.record({ actor: principal.id, action: "expense.advance.requested", entityType: "advance", entityId: id });
      return { advance, idempotent: false };
    },

    approveAdvance(principal, id) {
      requireRole(principal, "finance", "admin");
      const advance = getAdvance(id);
      if (advance.status !== "requested") throw conflict(`预支单状态为 ${advance.status}，无法审批`);
      store.update((s) => {
        s.advances[id].status = "approved";
        s.advances[id].approvedAt = iso(clock.now());
      });
      audit.record({ actor: principal.id, action: "expense.advance.approved", entityType: "advance", entityId: id });
      return store.state.advances[id];
    },

    disburseAdvance(principal, id) {
      requireRole(principal, "finance", "admin");
      const advance = getAdvance(id);
      if (advance.status !== "approved") throw conflict(`预支单状态为 ${advance.status}，无法拨付`);
      store.update((s) => {
        s.advances[id].status = "disbursed";
        s.advances[id].disbursedAt = iso(clock.now());
      });
      audit.record({ actor: principal.id, action: "expense.advance.disbursed", entityType: "advance", entityId: id });
      return store.state.advances[id];
    },

    submitReceipt(principal, advanceId, input) {
      const advance = getAdvance(advanceId);
      if (advance.journalistId !== principal.id && !isAdmin(principal)) {
        throw forbidden("只能为本人的预支提交票据");
      }
      if (advance.status !== "disbursed") throw conflict("预支尚未拨付，不能提交票据");
      const { receiptNo, amount, description = "" } = input;
      if (!receiptNo || !(amount > 0)) throw badRequest("票据需要 receiptNo 与正数金额");
      const duplicated = Object.values(store.state.receipts).some(
        (r) => r.journalistId === advance.journalistId && r.receiptNo === receiptNo,
      );
      if (duplicated) throw conflict(`票据号 ${receiptNo} 已提交过，禁止重复报销`);
      const id = input.id ?? randomId("rcp");
      if (store.state.receipts[id]) throw conflict(`票据 ${id} 已存在`);
      const receipt = {
        id,
        advanceId,
        journalistId: advance.journalistId,
        receiptNo,
        amount,
        currency: advance.currency,
        description,
        status: "submitted",
        occurredAt: input.occurredAt ?? iso(clock.now()),
        receivedAt: iso(clock.now()),
      };
      store.update((s) => {
        s.receipts[id] = receipt;
      });
      audit.record({ actor: principal.id, action: "expense.receipt.submitted", entityType: "receipt", entityId: id });
      return receipt;
    },

    reconcileReceipt(principal, receiptId) {
      requireRole(principal, "finance", "admin");
      const receipt = store.state.receipts[receiptId];
      if (!receipt) throw notFound(`票据 ${receiptId} 不存在`);
      if (receipt.status === "reconciled") throw conflict("该票据已核销，不能重复核销");
      if (receipt.status !== "submitted") throw conflict(`票据状态为 ${receipt.status}，无法核销`);
      const advance = getAdvance(receipt.advanceId);
      const total = reconciledTotal(receipt.advanceId);
      if (total + receipt.amount > advance.amount) {
        throw conflict(`核销后累计 ${total + receipt.amount} 超出预支额 ${advance.amount}`);
      }
      store.update((s) => {
        s.receipts[receiptId].status = "reconciled";
        s.receipts[receiptId].reconciledAt = iso(clock.now());
      });
      audit.record({ actor: principal.id, action: "expense.receipt.reconciled", entityType: "receipt", entityId: receiptId });
      return store.state.receipts[receiptId];
    },

    advanceStatus(principal, id) {
      const advance = getAdvance(id);
      const allowed =
        advance.journalistId === principal.id || isAdmin(principal) || principal.role === "finance";
      if (!allowed) throw forbidden("无权查看该预支单");
      return {
        ...advance,
        reconciledTotal: reconciledTotal(id),
        receipts: Object.values(store.state.receipts).filter((r) => r.advanceId === id),
      };
    },
  };
}
