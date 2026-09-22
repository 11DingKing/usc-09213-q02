import assert from "node:assert/strict";
import test from "node:test";
import { makeApp } from "./helpers.mjs";

async function disburseAdvance(api, amount = 1000) {
  const req = await api("tok-jour-1", "POST", "/v1/expenses/advances", {
    idempotencyKey: "trip-chengdu",
    amount,
    purpose: "成都采访差旅",
  });
  const id = req.body.id;
  await api("tok-fin-1", "POST", `/v1/expenses/advances/${id}/approve`);
  await api("tok-fin-1", "POST", `/v1/expenses/advances/${id}/disburse`);
  return id;
}

test("费用预支：同一幂等键重复提交只产生一张单", async (t) => {
  const { api } = await makeApp(t);
  const first = await api("tok-jour-1", "POST", "/v1/expenses/advances", {
    idempotencyKey: "trip-xian",
    amount: 800,
    purpose: "西安采访",
  });
  assert.equal(first.status, 201);
  const second = await api("tok-jour-1", "POST", "/v1/expenses/advances", {
    idempotencyKey: "trip-xian",
    amount: 800,
    purpose: "西安采访",
  });
  assert.equal(second.status, 200, "幂等命中返回 200 与原单");
  assert.equal(second.body.id, first.body.id);
  const list = await api("tok-jour-1", "GET", `/v1/expenses/advances/${first.body.id}`);
  assert.equal(list.body.amount, 800);
});

test("票据核销：票据号防重、核销一次、累计不超预支", async (t) => {
  const { api } = await makeApp(t);
  const advanceId = await disburseAdvance(api, 1000);

  // 正常提交两张票据。
  const r1 = await api("tok-jour-1", "POST", `/v1/expenses/advances/${advanceId}/receipts`, {
    receiptNo: "FP-001",
    amount: 600,
  });
  assert.equal(r1.status, 201);
  const r2 = await api("tok-jour-1", "POST", `/v1/expenses/advances/${advanceId}/receipts`, {
    receiptNo: "FP-002",
    amount: 400,
  });
  assert.equal(r2.status, 201);

  // 同一票据号重复提交被拒。
  const dup = await api("tok-jour-1", "POST", `/v1/expenses/advances/${advanceId}/receipts`, {
    receiptNo: "FP-001",
    amount: 100,
  });
  assert.equal(dup.status, 409);

  // 核销两张后达到预支额，再提交并核销会超额。
  assert.equal((await api("tok-fin-1", "POST", `/v1/expenses/receipts/${r1.body.id}/reconcile`)).status, 200);
  assert.equal((await api("tok-fin-1", "POST", `/v1/expenses/receipts/${r2.body.id}/reconcile`)).status, 200);

  // 重复核销被拒。
  const again = await api("tok-fin-1", "POST", `/v1/expenses/receipts/${r1.body.id}/reconcile`);
  assert.equal(again.status, 409);

  // 超额核销被拒：再提交 1 元票据，核销时超出预支额。
  const r3 = await api("tok-jour-1", "POST", `/v1/expenses/advances/${advanceId}/receipts`, {
    receiptNo: "FP-003",
    amount: 1,
  });
  assert.equal(r3.status, 201);
  const over = await api("tok-fin-1", "POST", `/v1/expenses/receipts/${r3.body.id}/reconcile`);
  assert.equal(over.status, 409);

  const status = await api("tok-fin-1", "GET", `/v1/expenses/advances/${advanceId}`);
  assert.equal(status.body.reconciledTotal, 1000);
});

test("费用流程：未拨付不能提交票据，记者不能审批", async (t) => {
  const { api } = await makeApp(t);
  const req = await api("tok-jour-1", "POST", "/v1/expenses/advances", {
    idempotencyKey: "trip-wuhan",
    amount: 500,
    purpose: "武汉采访",
  });
  const id = req.body.id;
  const early = await api("tok-jour-1", "POST", `/v1/expenses/advances/${id}/receipts`, {
    receiptNo: "FP-100",
    amount: 100,
  });
  assert.equal(early.status, 409, "未拨付不能提交票据");
  const selfApprove = await api("tok-jour-1", "POST", `/v1/expenses/advances/${id}/approve`);
  assert.equal(selfApprove.status, 403, "记者不能审批自己的预支");
});
