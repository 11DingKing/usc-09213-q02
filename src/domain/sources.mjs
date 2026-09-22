import { iso } from "../core/clock.mjs";
import { randomId, sha256 } from "../core/crypto.mjs";
import { badRequest, conflict, forbidden, notFound } from "../core/errors.mjs";
import { isOwner, requireClearance, requireRole } from "../core/auth.mjs";

// 加密来源层（最高密级）：
// - 内容在客户端用一次性内容密钥加密，服务端只保存密文；
// - 内容密钥用各接收方 RSA 公钥包裹后登记，服务端不持有明文密钥；
// - 只有来源负责人或被授予密钥的成员才能取得包裹密钥并解密；
// - 编辑做链路核验时只能拿到哈希与元数据，拿不到内容。
export function createSources({ store, clock, audit, principals }) {
  function getOrThrow(id) {
    const source = store.state.sources[id];
    if (!source) throw notFound(`来源 ${id} 不存在`);
    return source;
  }

  function assertContentAccess(principal, source) {
    // 注意：管理员也不能读取来源内容，只能看元数据。
    if (isOwner(principal, source)) return;
    const grant = source.grants[principal.id];
    if (grant && (!grant.expiresAt || Date.parse(grant.expiresAt) > clock.now())) return;
    throw forbidden("未获得该来源的访问授权");
  }

  return {
    // input.ciphertext 为客户端加密结果；wrappedKeys 形如 { principalId: base64 }。
    create(principal, input) {
      requireRole(principal, "journalist", "editor", "admin");
      const { title, ciphertext, contentHash } = input;
      if (!title || !ciphertext?.data || !ciphertext?.iv || !ciphertext?.tag) {
        throw badRequest("来源需要 title 与完整密文 (iv/tag/data)");
      }
      if (!contentHash) throw badRequest("来源需要明文哈希 contentHash（客户端计算）");
      const id = input.id ?? randomId("src");
      if (store.state.sources[id]) throw conflict(`来源 ${id} 已存在`);
      const source = {
        id,
        layer: "confidential",
        ownerId: principal.id,
        title,
        ciphertext,
        contentHash,
        ciphertextHash: sha256(JSON.stringify(ciphertext)),
        grants: {},
        createdAt: iso(clock.now()),
      };
      for (const [pid, wrappedKey] of Object.entries(input.wrappedKeys ?? {})) {
        source.grants[pid] = { wrappedKey, grantedAt: iso(clock.now()), expiresAt: null };
      }
      store.update((s) => {
        s.sources[id] = source;
      });
      audit.record({ actor: principal.id, action: "source.create", entityType: "source", entityId: id });
      return { id, contentHash, ciphertextHash: source.ciphertextHash, createdAt: source.createdAt };
    },

    // 元数据对 restricted 以上成员开放，用于链路核验；绝不含密文与密钥。
    meta(principal, id) {
      requireClearance(principal, "restricted");
      const source = getOrThrow(id);
      return {
        id: source.id,
        ownerId: source.ownerId,
        title: source.title,
        contentHash: source.contentHash,
        ciphertextHash: source.ciphertextHash,
        grantees: Object.keys(source.grants),
        createdAt: source.createdAt,
      };
    },

    // 密文只对负责人或有效被授权人开放。
    content(principal, id) {
      const source = getOrThrow(id);
      assertContentAccess(principal, source);
      return { id: source.id, title: source.title, ciphertext: source.ciphertext, contentHash: source.contentHash };
    },

    // 取回“我自己的”包裹密钥；他人一律拒绝。
    wrappedKeyFor(principal, id) {
      const source = getOrThrow(id);
      assertContentAccess(principal, source);
      const grant = isOwner(principal, source) ? source.grants[principal.id] : source.grants[principal.id];
      if (!grant) throw notFound("没有为你登记的包裹密钥");
      return { sourceId: id, wrappedKey: grant.wrappedKey };
    },

    // 授权 = 负责人把内容密钥用对方公钥包裹后登记。可设到期时间。
    grant(principal, id, input) {
      const source = getOrThrow(id);
      if (!isOwner(principal, source)) throw forbidden("只有来源负责人可以授权");
      const { granteeId, wrappedKey, expiresAt = null } = input;
      if (!granteeId || !wrappedKey) throw badRequest("授权需要 granteeId 与 wrappedKey");
      if (!principals.get(granteeId)) throw badRequest(`成员 ${granteeId} 不存在`);
      store.update((s) => {
        s.sources[id].grants[granteeId] = { wrappedKey, grantedAt: iso(clock.now()), expiresAt };
      });
      audit.record({
        actor: principal.id,
        action: "source.grant",
        entityType: "source",
        entityId: id,
        detail: { granteeId, expiresAt },
      });
      return { sourceId: id, granteeId, expiresAt };
    },

    revoke(principal, id, granteeId) {
      const source = getOrThrow(id);
      if (!isOwner(principal, source)) throw forbidden("只有来源负责人可以撤销授权");
      if (!source.grants[granteeId]) throw notFound("该授权不存在");
      store.update((s) => {
        delete s.sources[id].grants[granteeId];
      });
      audit.record({
        actor: principal.id,
        action: "source.revoke",
        entityType: "source",
        entityId: id,
        detail: { granteeId },
      });
      return { sourceId: id, granteeId, revoked: true };
    },
  };
}
