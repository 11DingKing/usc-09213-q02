import {
  canonicalJson,
  openJson,
  randomUUID,
  sealJson,
  sha256Hex,
  verifySealed,
} from "./security/crypto.mjs";
import { Ledger, verifyChain } from "./security/ledger.mjs";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "./errors.mjs";

const ROLES = ["journalist", "editor", "security", "admin"];
const RISK_LEVELS = ["low", "standard", "high"];

function requireActor(data, actorId) {
  const actor = data.actors[actorId];
  if (!actor) throw unauthorized();
  return actor;
}

export class Desk {
  constructor(store, clock, dataKey, { idGenerator = randomUUID } = {}) {
    this.store = store;
    this.data = store.data;
    this.clock = clock;
    this.dataKey = dataKey;
    this.newId = idGenerator;
    this.ledger = new Ledger(clock);
    this.ledger.restore(this.data.ledger);
  }

  save() {
    this.store.save();
  }

  /** 冷启动引导首个管理员时留痕。 */
  noteBootstrap(actorId) {
    this.#log({ type: "system.bootstrap", actorId: "system", subject: `actor:${actorId}`, payload: {} });
  }

  #log(entry) {
    const stored = this.ledger.append({ nodeId: this.data.meta.nodeId, ...entry });
    this.data.ledger.push(stored);
    return stored;
  }

  // ── 人员与授权 ───────────────────────────────────────────────

  registerActor(caller, { id, name, role, clearance = 1 }) {
    this.#requireRole(caller, "admin");
    if (!id || !name) throw badRequest("缺少 id 或 name");
    if (!ROLES.includes(role)) throw badRequest(`角色必须是 ${ROLES.join("/")}`);
    if (this.data.actors[id]) throw conflict("该身份已存在");
    const actor = { id, name, role, clearance, createdAt: this.clock.now() };
    this.data.actors[id] = actor;
    this.#log({ type: "actor.register", actorId: caller.id, subject: `actor:${id}`, payload: { role } });
    return actor;
  }

  /**
   * 授予分层访问权。expiresAt 到期后访问在检查点自动收紧，
   * 密文仍保留但不再可能被解密读取。
   */
  issueGrant(caller, { actorId, tier, scope = { kind: "all" }, expiresAt = null }) {
    this.#requireRole(caller, "admin");
    if (!this.data.actors[actorId]) throw notFound("被授权人不存在");
    if (![1, 2, 3].includes(tier)) throw badRequest("tier 必须是 1/2/3");
    if (!["all", "subject", "source"].includes(scope.kind)) throw badRequest("scope.kind 非法");
    if (scope.kind !== "all" && !scope.value) throw badRequest("scope 缺少 value");
    if (expiresAt !== null && !Number.isFinite(expiresAt)) throw badRequest("expiresAt 非法");
    const now = this.clock.now();
    const grant = {
      id: this.newId(),
      actorId,
      tier,
      scope,
      expiresAt,
      issuedAt: now,
      issuedBy: caller.id,
    };
    this.data.grants[grant.id] = grant;
    this.#log({
      type: "grant.issue",
      actorId: caller.id,
      subject: `grant:${grant.id}`,
      payload: { actorId, tier, scope, expiresAt },
    });
    return grant;
  }

  #effectiveGrants(actorId, at = this.clock.now()) {
    return Object.values(this.data.grants).filter(
      (grant) =>
        grant.actorId === actorId &&
        (grant.expiresAt === null || grant.expiresAt > at),
    );
  }

  #grantCovers(grant, record) {
    if (grant.tier < record.tier) return false;
    if (grant.scope.kind === "all") return true;
    if (grant.scope.kind === "subject") return grant.scope.value === record.subject;
    if (grant.scope.kind === "source") return grant.scope.value === record.sourceId;
    return false;
  }

  #requireRole(actor, ...roles) {
    if (!roles.includes(actor.role)) throw forbidden("该操作需要相应角色");
  }

  // ── 分层记录：公开行程 / 受限采访计划 / 加密来源 ──────────────

  static #contentOf({ tier, subject, sourceId, title, body }) {
    return { tier, subject, sourceId: sourceId ?? null, title, body };
  }

  createRecord(caller, input) {
    this.#requireRole(caller, "journalist", "admin");
    return this.#applyCreateRecord(caller, input);
  }

  #applyCreateRecord(caller, { id, tier, subject, sourceId = null, title, body }) {
    if (![1, 2, 3].includes(tier)) throw badRequest("tier 必须是 1/2/3");
    if (!subject || !title) throw badRequest("缺少 subject 或 title");
    if (tier === 3 && !sourceId) throw badRequest("加密来源记录必须绑定 sourceId");
    if (id && this.data.records[id]) throw conflict("记录标识冲突", { id });
    const now = this.clock.now();
    const content = Desk.#contentOf({ tier, subject, sourceId, title, body });
    const recordId = id ?? this.newId();
    const contentHash = sha256Hex(canonicalJson({ ...content, version: 1 }));
    const record = {
      id: recordId,
      tier,
      subject,
      sourceId,
      version: 1,
      createdBy: caller.id,
      createdAt: now,
      updatedAt: now,
      contentHash,
    };
    if (tier === 1) {
      record.envelope = { kind: "plain", title, body: body ?? null };
    } else {
      record.envelope = {
        kind: "sealed",
        sealed: sealJson(content, this.dataKey, `record:${recordId}`),
      };
    }
    this.data.records[recordId] = record;
    this.#log({
      type: "record.create",
      actorId: caller.id,
      subject: `record:${recordId}`,
      payload: { tier, subject, version: 1, contentHash },
    });
    return this.#project(record, null);
  }

  /**
   * 离线编辑回传时以 baseVersion 做乐观并发检测：
   * 服务端版本已前进则报冲突，不静默覆盖任何一方的修改。
   */
  updateRecord(caller, { id, baseVersion, title, body }) {
    this.#requireRole(caller, "journalist", "admin");
    const record = this.data.records[id];
    if (!record) throw notFound("记录不存在");
    if (!Number.isInteger(baseVersion)) throw badRequest("缺少 baseVersion");
    if (record.version !== baseVersion) {
      throw conflict("记录已被其他节点修改，存在离线冲突", {
        id,
        baseVersion,
        currentVersion: record.version,
      });
    }
    this.#authorizeRead(caller, record);

    const current = this.#readContent(record);
    const next = {
      ...current,
      title: title ?? current.title,
      body: body ?? current.body,
    };
    const now = this.clock.now();
    record.version += 1;
    record.updatedAt = now;
    record.contentHash = sha256Hex(canonicalJson({ ...next, version: record.version }));
    if (record.tier === 1) {
      record.envelope = { kind: "plain", title: next.title, body: next.body };
    } else {
      record.envelope = {
        kind: "sealed",
        sealed: sealJson(next, this.dataKey, `record:${record.id}`),
      };
    }
    this.#log({
      type: "record.update",
      actorId: caller.id,
      subject: `record:${record.id}`,
      payload: { version: record.version, contentHash: record.contentHash },
    });
    return this.#project(record, next);
  }

  #readContent(record) {
    if (record.envelope.kind === "plain") {
      return {
        tier: record.tier,
        subject: record.subject,
        sourceId: record.sourceId,
        title: record.envelope.title,
        body: record.envelope.body,
      };
    }
    return openJson(record.envelope.sealed, this.dataKey, `record:${record.id}`);
  }

  #authorizeRead(actor, record, at = this.clock.now()) {
    // 记录创建者（采写记者本人）始终可以读取自己的材料。
    if (record.createdBy === actor.id) return;
    if (record.tier === 1) return;
    const grant = this.#effectiveGrants(actor.id, at).find((candidate) =>
      this.#grantCovers(candidate, record),
    );
    if (!grant) {
      throw forbidden(
        record.tier === 3
          ? "未获得该加密来源的有效授权"
          : "未获得该受限计划的有效授权",
      );
    }
  }

  readRecord(actor, id) {
    const record = this.data.records[id];
    if (!record) throw notFound("记录不存在");
    this.#authorizeRead(actor, record);
    return this.#project(record, this.#readContent(record));
  }

  listRecords(actor, { tier = null } = {}) {
    const at = this.clock.now();
    return Object.values(this.data.records)
      .filter((record) => tier === null || record.tier === tier)
      .filter((record) => {
        if (record.createdBy === actor.id) return true;
        if (record.tier === 1) return true;
        return this.#effectiveGrants(actor.id, at).some((grant) => this.#grantCovers(grant, record));
      })
      .map((record) => this.#project(record, null));
  }

  #project(record, content) {
    return {
      id: record.id,
      tier: record.tier,
      subject: record.subject,
      sourceId: record.sourceId,
      version: record.version,
      updatedAt: record.updatedAt,
      contentHash: record.contentHash,
      ...(content ? { title: content.title, body: content.body } : {}),
    };
  }

  /**
   * 验证报道链路：核对内容哈希、密文完整性与账本锚点，
   * 全程不返回明文，因此编辑可验证链路而看不到未授权来源内容。
   */
  verifyRecord(actor, id) {
    const record = this.data.records[id];
    if (!record) throw notFound("记录不存在");
    const anchors = this.data.ledger
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.subject === `record:${id}`);

    let contentIntact = false;
    if (record.envelope.kind === "plain") {
      const content = this.#readContent(record);
      contentIntact =
        sha256Hex(canonicalJson({ ...content, version: record.version })) === record.contentHash;
    } else {
      contentIntact = verifySealed(
        record.envelope.sealed,
        this.dataKey,
        `record:${record.id}`,
      );
    }

    const chain = verifyChain(this.data.ledger);
    return {
      id,
      tier: record.tier,
      version: record.version,
      contentHash: record.contentHash,
      contentIntact,
      ledgerAnchors: anchors.map(({ entry, index }) => ({
        index,
        type: entry.type,
        hash: entry.hash,
      })),
      ledgerChainOk: chain.ok,
      ledgerTip: chain.tip,
      viewerMayReadPlaintext: (() => {
        try {
          this.#authorizeRead(actor, record);
          return true;
        } catch {
          return false;
        }
      })(),
    };
  }

  // ── 临时变更事件：有确认期限，逾期升级 ────────────────────────

  publishEvent(caller, { title, severity = "info", audience, deadline, summary = null }) {
    this.#requireRole(caller, "editor", "security", "admin");
    if (!title) throw badRequest("缺少 title");
    if (!["info", "warning", "urgent"].includes(severity)) throw badRequest("severity 非法");
    if (!Number.isFinite(deadline) || deadline <= this.clock.now()) {
      throw badRequest("deadline 必须是未来的确认期限时间戳");
    }
    let requiredActorIds;
    if (!audience) throw badRequest("缺少 audience");
    if (audience.actorIds) {
      requiredActorIds = [...new Set(audience.actorIds)];
      for (const actorId of requiredActorIds) {
        if (!this.data.actors[actorId]) throw notFound(`受众 ${actorId} 不存在`);
      }
    } else if (audience.roles) {
      for (const role of audience.roles) {
        if (!ROLES.includes(role)) throw badRequest("受众角色非法");
      }
      requiredActorIds = Object.values(this.data.actors)
        .filter((actor) => audience.roles.includes(actor.role))
        .map((actor) => actor.id);
    } else {
      throw badRequest("audience 需要 actorIds 或 roles");
    }
    const event = {
      id: this.newId(),
      title,
      severity,
      summary,
      requiredActorIds,
      publishedBy: caller.id,
      publishedAt: this.clock.now(),
      deadline,
      acks: {},
      status: requiredActorIds.length === 0 ? "acknowledged" : "open",
      overdueAnnounced: false,
    };
    this.data.events[event.id] = event;
    this.#log({
      type: "event.publish",
      actorId: caller.id,
      subject: `event:${event.id}`,
      payload: { severity, deadline, requiredActorIds },
    });
    return this.#projectEvent(event, caller);
  }

  acknowledgeEvent(actor, eventId) {
    const event = this.data.events[eventId];
    if (!event) throw notFound("事件不存在");
    if (!event.requiredActorIds.includes(actor.id)) {
      throw forbidden("你不在该事件的确认受众范围内");
    }
    if (!event.acks[actor.id]) {
      event.acks[actor.id] = this.clock.now();
      this.#log({
        type: "event.ack",
        actorId: actor.id,
        subject: `event:${eventId}`,
        payload: {},
      });
    }
    this.#refreshEventStatus(event, this.clock.now());
    return this.#projectEvent(event, actor);
  }

  #refreshEventStatus(event, at) {
    const ackedAll = event.requiredActorIds.every((actorId) => event.acks[actorId]);
    if (ackedAll) {
      event.status = "acknowledged";
    } else if (at > event.deadline) {
      event.status = "overdue";
    } else {
      event.status = "open";
    }
  }

  #canSeeEvent(actor, event) {
    return (
      event.requiredActorIds.includes(actor.id) ||
      ["security", "admin", "editor"].includes(actor.role) ||
      event.publishedBy === actor.id
    );
  }

  #projectEvent(event, actor) {
    const visible = this.#canSeeEvent(actor, event);
    const privileged = ["security", "admin", "editor"].includes(actor.role) || event.publishedBy === actor.id;
    return {
      id: event.id,
      title: visible ? event.title : "(不可见)",
      severity: event.severity,
      summary: visible ? event.summary : null,
      deadline: event.deadline,
      status: event.status,
      publishedAt: event.publishedAt,
      required: event.requiredActorIds.length,
      acked: Object.keys(event.acks).length,
      ackedByMe: Boolean(event.acks[actor.id]),
      // 受众名单只对发布方与值班角色开放。
      ...(privileged ? { requiredActorIds: event.requiredActorIds } : {}),
    };
  }

  listEvents(actor) {
    this.sweep();
    return Object.values(this.data.events)
      .filter((event) => this.#canSeeEvent(actor, event))
      .map((event) => this.#projectEvent(event, actor));
  }

  // ── 安全报平安与失联升级 ─────────────────────────────────────

  setSafetyPlan(caller, { journalistId, riskLevel, intervalMs, graceMs }) {
    this.#requireRole(caller, "security", "admin");
    const journalist = this.data.actors[journalistId];
    if (!journalist || journalist.role !== "journalist") throw notFound("记者不存在");
    if (!RISK_LEVELS.includes(riskLevel)) throw badRequest("riskLevel 非法");
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw badRequest("intervalMs 非法");
    if (!Number.isFinite(graceMs) || graceMs < 0) throw badRequest("graceMs 非法");

    for (const trip of Object.values(this.data.trips)) {
      if (trip.journalistId === journalistId && trip.active) trip.active = false;
    }
    const now = this.clock.now();
    const trip = {
      id: this.newId(),
      journalistId,
      riskLevel,
      intervalMs,
      graceMs,
      startedAt: now,
      active: true,
    };
    this.data.trips[trip.id] = trip;
    this.#openCheckin(trip, now, 1);
    this.#log({
      type: "safety.plan",
      actorId: caller.id,
      subject: `trip:${trip.id}`,
      payload: { journalistId, riskLevel, intervalMs, graceMs },
    });
    return trip;
  }

  #openCheckin(trip, fromTime, index) {
    const checkin = {
      id: this.newId(),
      tripId: trip.id,
      journalistId: trip.journalistId,
      riskLevel: trip.riskLevel,
      index,
      expectedAt: fromTime + trip.intervalMs,
      graceUntil: fromTime + trip.intervalMs + trip.graceMs,
      status: "pending",
      escalationLevel: 0,
      confirmedAt: null,
      locationEnvelope: null,
    };
    this.data.checkins.push(checkin);
    return checkin;
  }

  /**
   * 记者报平安。位置以密文信封保存，AAD 绑定本次报平安记录，
   * 只有 security/admin 在读取时可解密；升级事件本身绝不携带定位。
   */
  checkin(actor, { journalistId = actor.id, location = null, at = null } = {}) {
    const journalist = requireActor(this.data, journalistId);
    if (journalist.role !== "journalist") throw badRequest("该身份不是记者");
    if (actor.id !== journalistId) this.#requireRole(actor, "security", "admin");
    const trip = Object.values(this.data.trips).find(
      (candidate) => candidate.journalistId === journalistId && candidate.active,
    );
    if (!trip) throw notFound("该记者没有进行中的行程安全计划");

    const time = at ?? this.clock.now();
    // 客户端可上报事件发生时间，但不得是未来时间；接收时间始终以服务器时钟为准。
    const receivedAt = this.clock.now();
    if (time > receivedAt) throw badRequest("报平安的事件时间不能晚于服务器当前时间");
    const lastConfirmed = this.data.checkins
      .filter((item) => item.tripId === trip.id && item.confirmedAt !== null)
      .at(-1);
    if (lastConfirmed && time < lastConfirmed.confirmedAt) {
      throw conflict("报平安时间早于该行程最近一次确认，存在乱序回传", {
        lastConfirmedAt: lastConfirmed.confirmedAt,
      });
    }
    // 迟到的报平安（窗口已逾期甚至已升级）也在对应窗口上确认，解除升级状态。
    let pending = this.data.checkins
      .filter((item) => item.tripId === trip.id)
      .find((item) => ["pending", "overdue", "escalated"].includes(item.status));
    if (!pending) {
      const last = this.data.checkins.filter((item) => item.tripId === trip.id).at(-1);
      pending = this.#openCheckin(trip, Math.max(last?.confirmedAt ?? trip.startedAt, time), last.index + 1);
    }
    pending.status = "confirmed";
    pending.confirmedAt = time;
    pending.escalationLevel = 0;
    if (location) {
      pending.locationEnvelope = {
        sealed: sealJson(
          { ...location, reportedAt: time },
          this.dataKey,
          `checkin:${pending.id}`,
        ),
      };
    }
    this.#log({
      type: "safety.checkin",
      actorId: actor.id,
      subject: `checkin:${pending.id}`,
      payload: { journalistId, confirmedAt: time, hasLocation: Boolean(location) },
      eventTime: time,
    });
    this.#openCheckin(trip, time, pending.index + 1);
    this.sweep();
    return { checkinId: pending.id, confirmedAt: time };
  }

  safetyStatus(actor) {
    this.sweep();
    const maySeeLocation = ["security", "admin"].includes(actor.role);
    const privileged = ["security", "admin", "editor"].includes(actor.role);
    return Object.values(this.data.trips)
      .filter((trip) => privileged || trip.journalistId === actor.id)
      .map((trip) => {
        const windows = this.data.checkins.filter((item) => item.tripId === trip.id);
        const current = windows.at(-1);
        const lastConfirmed = windows.filter((item) => item.confirmedAt !== null).at(-1);
        const base = {
          tripId: trip.id,
          journalistId: trip.journalistId,
          riskLevel: trip.riskLevel,
          active: trip.active,
          status: current.status,
          escalationLevel: current.escalationLevel,
          expectedAt: current.expectedAt,
          confirmedAt: lastConfirmed?.confirmedAt ?? null,
        };
        // 定位只对安全岗开放；其他角色（含编辑）只看到状态与升级级别。
        if (maySeeLocation && lastConfirmed?.locationEnvelope) {
          base.lastLocation = openJson(
            lastConfirmed.locationEnvelope.sealed,
            this.dataKey,
            `checkin:${lastConfirmed.id}`,
          );
        }
        return base;
      });
  }

  #sweepCheckins(at) {
    const activeTrips = Object.values(this.data.trips).filter((trip) => trip.active);
    for (const trip of activeTrips) {
      const pending = this.data.checkins
        .filter((item) => item.tripId === trip.id)
        .find((item) => ["pending", "overdue"].includes(item.status));
      if (!pending) continue;
      if (at > pending.graceUntil && pending.escalationLevel < 2) {
        pending.status = "escalated";
        pending.escalationLevel = 2;
        this.#escalate(pending, at, 2, "超过宽限仍失联，升级至应急联系人");
      } else if (at > pending.expectedAt && pending.escalationLevel < 1) {
        pending.status = "overdue";
        // 高风险：逾期即二级升级；普通/低风险先一级（安全值班台）。
        if (pending.riskLevel === "high") {
          pending.status = "escalated";
          pending.escalationLevel = 2;
          this.#escalate(pending, at, 2, "高风险行程逾期未报平安，直接二级升级");
        } else {
          pending.escalationLevel = 1;
          this.#escalate(pending, at, 1, "逾期未报平安，通知安全值班台");
        }
      }
    }
  }

  #escalate(checkin, at, level, reason) {
    this.#log({
      type: "safety.escalation",
      actorId: "system",
      subject: `checkin:${checkin.id}`,
      // 注意：升级事件只含身份与级别，不含任何定位信息。
      payload: {
        journalistId: checkin.journalistId,
        riskLevel: checkin.riskLevel,
        escalationLevel: level,
        reason,
      },
      eventTime: at,
    });
    const securityActorIds = Object.values(this.data.actors)
      .filter((actor) => actor.role === "security" || (level === 2 && actor.role === "admin"))
      .map((actor) => actor.id);
    if (securityActorIds.length > 0) {
      const event = {
        id: this.newId(),
        title: `失联升级 L${level}：记者 ${checkin.journalistId}`,
        severity: level === 2 ? "urgent" : "warning",
        summary: reason,
        requiredActorIds: securityActorIds,
        publishedBy: "system",
        publishedAt: at,
        deadline: at + (level === 2 ? 15 * 60_000 : 60 * 60_000),
        acks: {},
        status: "open",
        overdueAnnounced: false,
      };
      this.data.events[event.id] = event;
    }
  }

  // ── 费用预支与票据核销 ──────────────────────────────────────

  createAdvance(caller, { journalistId, amount, currency = "CNY" }) {
    this.#requireRole(caller, "editor", "admin");
    const journalist = this.data.actors[journalistId];
    if (!journalist || journalist.role !== "journalist") throw notFound("记者不存在");
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest("amount 必须为正数");
    const advance = {
      id: this.newId(),
      journalistId,
      amount,
      currency,
      remaining: amount,
      status: "open",
      issuedAt: this.clock.now(),
      receiptIds: [],
    };
    this.data.advances[advance.id] = advance;
    this.#log({
      type: "finance.advance",
      actorId: caller.id,
      subject: `advance:${advance.id}`,
      payload: { journalistId, amount, currency },
    });
    return advance;
  }

  submitReceipt(caller, { id, advanceId, amount, vendor, invoiceNo, date, currency }) {
    this.#requireRole(caller, "journalist", "admin");
    const advance = this.data.advances[advanceId];
    if (!advance) throw notFound("预支记录不存在");
    if (caller.role === "journalist" && caller.id !== advance.journalistId) {
      throw forbidden("只能核销本人的预支");
    }
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest("amount 必须为正数");
    if (!vendor || !invoiceNo || !date) throw badRequest("票据缺少 vendor/invoiceNo/date");
    const currencyCode = currency ?? advance.currency;
    if (currencyCode !== advance.currency) throw badRequest("票据币种与预支不一致");
    if (amount > advance.remaining + 1e-9) {
      throw badRequest("票据金额超过预支剩余额度", { remaining: advance.remaining });
    }
    // 防重复核销：同一票据指纹只能入账一次。
    const fingerprint = sha256Hex(
      canonicalJson({ vendor, invoiceNo, date, amount, currency: currencyCode }),
    );
    const duplicate = Object.values(this.data.receipts).find((item) => item.fingerprint === fingerprint);
    if (duplicate) {
      throw conflict("该票据已核销，禁止重复入账", { duplicateOf: duplicate.id });
    }
    const receipt = {
      id: id ?? this.newId(),
      advanceId,
      amount,
      currency: currencyCode,
      vendor,
      invoiceNo,
      date,
      fingerprint,
      submittedBy: caller.id,
      appliedAt: this.clock.now(),
    };
    this.data.receipts[receipt.id] = receipt;
    advance.remaining = roundMoney(advance.remaining - amount);
    advance.receiptIds.push(receipt.id);
    if (advance.remaining === 0) advance.status = "settled";
    this.#log({
      type: "finance.receipt",
      actorId: caller.id,
      subject: `receipt:${receipt.id}`,
      payload: { advanceId, amount, fingerprint },
    });
    return { receipt, advance };
  }

  getAdvance(actor, id) {
    const advance = this.data.advances[id];
    if (!advance) throw notFound("预支记录不存在");
    if (
      actor.role === "journalist" &&
      actor.id !== advance.journalistId
    ) {
      throw forbidden("只能查看本人的预支");
    }
    return {
      ...advance,
      receipts: advance.receiptIds.map((receiptId) => {
        const receipt = this.data.receipts[receiptId];
        return {
          id: receipt.id,
          amount: receipt.amount,
          currency: receipt.currency,
          vendor: receipt.vendor,
          invoiceNo: receipt.invoiceNo,
          date: receipt.date,
          appliedAt: receipt.appliedAt,
        };
      }),
    };
  }

  // ── 弱网离线回传：幂等、冲突检测、安全计时恢复 ────────────────

  /**
   * 批量回传客户端离线期间产生的操作。
   * - opId 幂等：重复回传返回首次结果，绝不重复生效；
   * - 事件时间随操作携带（eventTime），接收时间以服务器时钟为准；
   * - 版本冲突逐条报告，不影响同批其他操作。
   */
  sync(actor, ops) {
    if (!Array.isArray(ops)) throw badRequest("ops 必须是数组");
    const results = [];
    for (const op of ops) {
      if (!op || typeof op !== "object" || !op.opId || !op.type) {
        throw badRequest("每个操作需要 opId 与 type");
      }
      const known = this.data.idempotency[op.opId];
      if (known) {
        results.push({ opId: op.opId, duplicate: true, ...known });
        continue;
      }
      try {
        const result = this.#applyOp(actor, op);
        // 只保存不含明文的最小回执，避免受限内容经幂等缓存明文落盘。
        const recorded = { status: "applied", result: this.#summarizeOpResult(op, result) };
        this.data.idempotency[op.opId] = recorded;
        results.push({ opId: op.opId, duplicate: false, status: "applied", result });
      } catch (error) {
        const recorded = {
          status: "rejected",
          error: { code: error.code ?? "error", message: error.message, details: error.details },
        };
        // 冲突与拒绝也按 opId 记录，保证重试时行为一致。
        this.data.idempotency[op.opId] = recorded;
        results.push({ opId: op.opId, duplicate: false, ...recorded });
      }
    }
    this.sweep();
    return { serverTime: this.clock.now(), results };
  }

  #applyOp(actor, op) {
    switch (op.type) {
      case "record.create":
        return this.createRecord(actor, { id: op.entityId, ...op.payload });
      case "record.update":
        return this.updateRecord(actor, op.payload);
      case "event.ack":
        return this.acknowledgeEvent(actor, op.payload.eventId);
      case "safety.checkin":
        return this.checkin(actor, { ...op.payload, at: op.eventTime ?? null });
      case "finance.receipt":
        return this.submitReceipt(actor, { id: op.entityId, ...op.payload });
      default:
        throw badRequest(`不支持的操作类型：${op.type}`);
    }
  }

  #summarizeOpResult(op, result) {
    switch (op.type) {
      case "record.create":
      case "record.update":
        return {
          id: result.id,
          tier: result.tier,
          version: result.version,
          updatedAt: result.updatedAt,
          contentHash: result.contentHash,
        };
      case "event.ack":
        return { id: result.id, status: result.status, ackedByMe: result.ackedByMe };
      case "finance.receipt":
        return {
          receipt: { id: result.receipt.id, advanceId: result.receipt.advanceId, fingerprint: result.receipt.fingerprint },
          advance: { id: result.advance.id, remaining: result.advance.remaining, status: result.advance.status },
        };
      default:
        return result;
    }
  }

  /**
   * 按服务器时间推进所有期限状态。时钟为持久化单调时钟，
   * 进程重启后不会因系统时间回拨而错过升级或重开已到期授权。
   */
  sweep() {
    const at = this.clock.now();
    this.#sweepCheckins(at);
    for (const event of Object.values(this.data.events)) {
      this.#refreshEventStatus(event, at);
      if (event.status === "overdue" && !event.overdueAnnounced) {
        event.overdueAnnounced = true;
        this.#log({
          type: "event.overdue",
          actorId: "system",
          subject: `event:${event.id}`,
          payload: { requiredActorIds: event.requiredActorIds, missing: this.#missingAcks(event) },
          eventTime: at,
        });
      }
    }
  }

  #missingAcks(event) {
    return event.requiredActorIds.filter((actorId) => !event.acks[actorId]);
  }
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export { requireActor };
