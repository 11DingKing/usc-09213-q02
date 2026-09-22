import { iso } from "../core/clock.mjs";
import { randomId } from "../core/crypto.mjs";
import { badRequest, conflict, forbidden, notFound } from "../core/errors.mjs";
import { isAdmin, isOwner } from "../core/auth.mjs";

// 现场笔记：弱网环境下可离线编辑，回传时携带 baseVersion。
// 服务端版本与 baseVersion 不一致即判定冲突：保留双方版本，
// 原样记录客户端补丁，由人工选择解决，绝不静默覆盖。
export function createNotes({ store, clock, audit }) {
  function getOrThrow(id) {
    const note = store.state.notes[id];
    if (!note) throw notFound(`笔记 ${id} 不存在`);
    return note;
  }

  function assertOwn(principal, note) {
    if (!isOwner(principal, note) && !isAdmin(principal)) throw forbidden("只能操作本人的笔记");
  }

  function applyUpdate(note, patch, occurredAt) {
    return store.update((s) => {
      const target = s.notes[note.id];
      if (patch.title !== undefined) target.title = patch.title;
      if (patch.body !== undefined) target.body = patch.body;
      target.version += 1;
      target.updatedAt = iso(clock.now());
      target.lastEventAt = occurredAt;
      return { ...target };
    });
  }

  function recordConflict(note, input) {
    const conflictRecord = {
      id: randomId("cfl"),
      noteId: note.id,
      ownerId: note.ownerId,
      serverVersion: note.version,
      serverSnapshot: { title: note.title, body: note.body },
      clientBaseVersion: input.baseVersion,
      clientPatch: { title: input.title, body: input.body },
      clientEventAt: input.occurredAt ?? null,
      receivedAt: iso(clock.now()),
      status: "open",
    };
    store.update((s) => {
      s.conflicts[conflictRecord.id] = conflictRecord;
    });
    audit.record({
      actor: note.ownerId,
      action: "note.conflict",
      entityType: "note",
      entityId: note.id,
      detail: { conflictId: conflictRecord.id, serverVersion: note.version, clientBaseVersion: input.baseVersion },
    });
    return conflictRecord;
  }

  return {
    create(principal, input) {
      if (!input.title) throw badRequest("笔记需要 title");
      const id = input.id ?? randomId("not");
      if (store.state.notes[id]) throw conflict(`笔记 ${id} 已存在`);
      const note = {
        id,
        ownerId: principal.id,
        title: input.title,
        body: input.body ?? "",
        version: 1,
        occurredAt: input.occurredAt ?? iso(clock.now()),
        receivedAt: iso(clock.now()),
        updatedAt: iso(clock.now()),
        lastEventAt: input.occurredAt ?? iso(clock.now()),
      };
      store.update((s) => {
        s.notes[id] = note;
      });
      audit.record({ actor: principal.id, action: "note.create", entityType: "note", entityId: id });
      return note;
    },

    update(principal, id, input) {
      const note = getOrThrow(id);
      assertOwn(principal, note);
      if (input.baseVersion === undefined) throw badRequest("更新需要携带 baseVersion");
      if (input.baseVersion !== note.version) {
        const c = recordConflict(note, input);
        throw conflict(`版本冲突：服务端版本 ${note.version}，你的基线 ${input.baseVersion}`, {
          conflictId: c.id,
        });
      }
      const updated = applyUpdate(note, input, input.occurredAt ?? iso(clock.now()));
      audit.record({ actor: principal.id, action: "note.update", entityType: "note", entityId: id });
      return updated;
    },

    // 弱网回传：批量提交，逐条应用或登记冲突，整体结果一次返回。
    syncBatch(principal, items) {
      if (!Array.isArray(items) || items.length === 0) throw badRequest("同步批次不能为空");
      const applied = [];
      const conflicts = [];
      for (const item of items) {
        const existing = item.id ? store.state.notes[item.id] : null;
        if (!existing) {
          applied.push(this.create(principal, item));
          continue;
        }
        assertOwn(principal, existing);
        if (item.baseVersion !== existing.version) {
          conflicts.push(recordConflict(existing, item));
          continue;
        }
        applied.push(applyUpdate(existing, item, item.occurredAt ?? iso(clock.now())));
      }
      return { applied, conflicts };
    },

    listConflicts(principal) {
      return Object.values(store.state.conflicts).filter(
        (c) => c.status === "open" && (c.ownerId === principal.id || isAdmin(principal)),
      );
    },

    // 解决冲突：选择保留服务端、采用客户端，或提交合并内容。
    resolveConflict(principal, conflictId, input) {
      const c = store.state.conflicts[conflictId];
      if (!c) throw notFound(`冲突 ${conflictId} 不存在`);
      if (c.status !== "open") throw conflict("该冲突已解决");
      const note = getOrThrow(c.noteId);
      assertOwn(principal, note);
      const { choice } = input;
      let result = note;
      if (choice === "client") {
        result = applyUpdate(note, c.clientPatch, c.clientEventAt ?? iso(clock.now()));
      } else if (choice === "merged") {
        result = applyUpdate(note, { title: input.title ?? note.title, body: input.body ?? note.body }, iso(clock.now()));
      } else if (choice !== "server") {
        throw badRequest("choice 必须是 server/client/merged");
      }
      store.update((s) => {
        s.conflicts[conflictId].status = "resolved";
        s.conflicts[conflictId].resolution = choice;
        s.conflicts[conflictId].resolvedAt = iso(clock.now());
      });
      audit.record({
        actor: principal.id,
        action: "note.conflict.resolved",
        entityType: "note",
        entityId: note.id,
        detail: { conflictId, choice },
      });
      return { conflict: store.state.conflicts[conflictId], note: result };
    },

    get(principal, id) {
      const note = getOrThrow(id);
      assertOwn(principal, note);
      return note;
    },
  };
}
