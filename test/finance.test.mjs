import assert from "node:assert/strict";
import test from "node:test";
import { makeActors, makeDesk } from "./helpers.mjs";

test("预支与票据核销：扣减余额，结算后关闭", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist } = makeActors(desk);

  const advance = desk.createAdvance(admin, { journalistId: "j1", amount: 1000, currency: "CNY" });
  const r1 = desk.submitReceipt(journalist, {
    advanceId: advance.id,
    amount: 600,
    vendor: "铁路售票",
    invoiceNo: "T-001",
    date: "2026-09-22",
  });
  assert.equal(r1.advance.remaining, 400);
  assert.equal(r1.advance.status, "open");

  desk.submitReceipt(journalist, {
    advanceId: advance.id,
    amount: 400,
    vendor: "酒店",
    invoiceNo: "H-77",
    date: "2026-09-23",
  });
  const settled = desk.getAdvance(journalist, advance.id);
  assert.equal(settled.remaining, 0);
  assert.equal(settled.status, "settled");
  assert.equal(settled.receipts.length, 2);
});

test("同一张票据不能重复核销", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist } = makeActors(desk);
  const advance = desk.createAdvance(admin, { journalistId: "j1", amount: 1000 });
  const receipt = { advanceId: advance.id, amount: 100, vendor: "出租", invoiceNo: "X-1", date: "2026-09-22" };
  desk.submitReceipt(journalist, receipt);
  assert.throws(() => desk.submitReceipt(journalist, { ...receipt, invoiceNo: "X-1" }), /重复/);
  // 即使换一个收据编号，供应商/发票号/日期/金额完全一致也视为同一张票。
  assert.equal(desk.getAdvance(journalist, advance.id).remaining, 900);
});

test("超额票据被拒绝且不产生任何入账", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist } = makeActors(desk);
  const advance = desk.createAdvance(admin, { journalistId: "j1", amount: 100 });
  assert.throws(
    () =>
      desk.submitReceipt(journalist, {
        advanceId: advance.id,
        amount: 120,
        vendor: "航空",
        invoiceNo: "A-9",
        date: "2026-09-22",
      }),
    /剩余额度/,
  );
  assert.equal(desk.getAdvance(journalist, advance.id).receipts.length, 0);
});

test("记者不能核销他人预支", () => {
  const env = makeDesk();
  const { desk } = env;
  const { admin, journalist2 } = makeActors(desk);
  const advance = desk.createAdvance(admin, { journalistId: "j1", amount: 500 });
  assert.throws(
    () =>
      desk.submitReceipt(journalist2, {
        advanceId: advance.id,
        amount: 10,
        vendor: "餐饮",
        invoiceNo: "F-1",
        date: "2026-09-22",
      }),
    /本人的预支/,
  );
});
