const SYNC_PROTOCOL = 1;
const SYNC_POLL_INTERVAL_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const READ_ONLY_ERROR_CODES = new Set([
  "OFFLINE_ACCESS_DISABLED",
  "WORK_ACCESS_DENIED",
  "WORK_EDIT_DENIED",
  "WORK_MODULE_READ_DENIED",
  "WORK_MODULE_WRITE_DENIED",
  "WORK_OWNER_REQUIRED"
]);

export class MobileSyncClientError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "MobileSyncClientError";
    this.code = code;
    this.status = options.status ?? 0;
    this.retryable = options.retryable === true;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

function responseError(payload, response) {
  const code = typeof payload?.error?.code === "string" ? payload.error.code : `SYNC_HTTP_${response.status}`;
  const message = typeof payload?.error?.message === "string" ? payload.error.message : "同步请求失败，请稍后重试";
  const retryAfter = Number(response.headers.get("retry-after"));
  return new MobileSyncClientError(code, message, {
    status: response.status,
    retryable: RETRYABLE_STATUS.has(response.status),
    retryAfterSeconds: Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : null
  });
}

async function jsonResponse(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) throw new MobileSyncClientError("SYNC_RESPONSE_INVALID", "Server 返回的内容无法识别");
  }
  if (!response.ok) throw responseError(payload, response);
  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    throw new MobileSyncClientError("SYNC_RESPONSE_INVALID", "Server 返回的内容无法识别");
  }
  return payload.data;
}

function retryDelay(attempts, retryAfterSeconds = null) {
  if (retryAfterSeconds) return retryAfterSeconds * 1_000;
  return Math.min(5 * 60_000, 1_000 * (2 ** Math.max(0, Math.min(8, attempts - 1))));
}

function rangesOverlap(range, version) {
  return range && Number(range.min) <= version && Number(range.max) >= version;
}

export function syncMutationSnapshot(entityType, snapshot) {
  if (entityType === "chapter") {
    return {
      title: String(snapshot?.title ?? ""),
      content: String(snapshot?.content ?? ""),
      chapterType: ["正文", "番外", "设定", "作者的话", "其他"].includes(snapshot?.chapterType) ? snapshot.chapterType : "正文"
    };
  }
  if (entityType === "setting") {
    return {
      title: String(snapshot?.title ?? ""),
      category: String(snapshot?.category ?? ""),
      content: String(snapshot?.content ?? ""),
      tags: Array.isArray(snapshot?.tags) ? snapshot.tags : [],
      status: ["draft", "pending", "confirmed", "deprecated"].includes(snapshot?.status) ? snapshot.status : "draft",
      locked: snapshot?.locked === true,
      evidence: Array.isArray(snapshot?.evidence) ? snapshot.evidence : [],
      scope: snapshot?.scope && typeof snapshot.scope === "object" && !Array.isArray(snapshot.scope) ? snapshot.scope : {},
      authorNote: String(snapshot?.authorNote ?? "")
    };
  }
  throw new MobileSyncClientError("SYNC_ENTITY_TYPE_UNSUPPORTED", "该类型暂不支持离线同步");
}

export class MobileSyncClient {
  constructor({
    profile = null,
    user,
    store,
    csrfToken = null,
    fetchImpl = globalThis.fetch,
    online = () => globalThis.navigator?.onLine !== false,
    pollIntervalMs = SYNC_POLL_INTERVAL_MS
  }) {
    this.profile = profile;
    this.user = user;
    this.store = store;
    this.getCsrfToken = typeof csrfToken === "function" ? csrfToken : () => csrfToken;
    this.fetch = (input, init) => fetchImpl(input, init);
    this.online = online;
    this.syncing = new Set();
    this.disposed = false;
    this.handleOnline = () => { void this.syncAll(); };
    globalThis.addEventListener?.("online", this.handleOnline);
    this.pollTimer = Number(pollIntervalMs) > 0
      ? globalThis.setInterval?.(() => { void this.syncAll(); }, Number(pollIntervalMs)) ?? null
      : null;
  }

  async request(path, options = {}) {
    const method = String(options.method ?? "GET").toUpperCase();
    let response;
    try {
      response = await this.fetch(path, {
        method,
        headers: {
          Accept: "application/json",
          ...(method === "GET" || method === "HEAD" || method === "OPTIONS" || !this.getCsrfToken()
            ? {}
            : { "X-CSRF-Token": this.getCsrfToken() }),
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: "error",
        cache: "no-store"
      });
    } catch (error) {
      throw new MobileSyncClientError("SYNC_NETWORK_ERROR", "无法连接 Server，本地变更已保留", { retryable: true, cause: error });
    }
    return jsonResponse(response);
  }

  async downloadWork(work, { scheduleRequest = null } = {}) {
    if (!work?.id) throw new MobileSyncClientError("SYNC_WORK_INVALID", "请先选择要下载的作品");
    if (work.offlineAccessEnabled !== true) {
      throw new MobileSyncClientError("OFFLINE_ACCESS_DISABLED", "作品所有者尚未允许 手机端离线访问");
    }
    const request = (path, options = {}) => typeof scheduleRequest === "function"
      ? scheduleRequest(() => this.request(path, options))
      : this.request(path, options);
    const descriptor = await request(`/api/sync/works/${encodeURIComponent(work.id)}/snapshots`, { method: "POST", body: {} });
    const items = [];
    let after = 0;
    try {
      while (true) {
        const page = await request(`/api/sync/snapshots/${encodeURIComponent(descriptor.snapshotId)}/items?after=${after}&limit=100`);
        items.push(...page.items);
        if (!page.hasMore) break;
        if (!Number.isInteger(page.nextAfter) || page.nextAfter <= after) {
          throw new MobileSyncClientError("SYNC_SNAPSHOT_INVALID", "Server 返回的离线数据不完整");
        }
        after = page.nextAfter;
      }
      const stored = await this.store.replaceSnapshot({
        workId: work.id,
        cutoffCursor: descriptor.cutoffCursor,
        items,
        permissionsSnapshot: {
          accessRole: work.accessRole ?? "viewer",
          modulePermissions: work.modulePermissions ?? null
        }
      });
      await this.emitStatus("downloaded", work.id);
      return stored;
    } finally {
      await request(`/api/sync/snapshots/${encodeURIComponent(descriptor.snapshotId)}`, { method: "DELETE" }).catch(() => undefined);
    }
  }

  async syncAll() {
    if (this.disposed || !this.online()) return [];
    const works = await this.store.listWorks();
    const results = [];
    for (const work of works) results.push(await this.syncWork(work.workId).catch((error) => ({ status: "failed", error })));
    return results;
  }

  async syncWork(workId) {
    if (this.disposed) return { status: "disposed" };
    if (!this.online()) {
      await this.store.setWorkStatus(workId, "offline");
      await this.emitStatus("offline", workId);
      return { status: "offline" };
    }
    if (this.syncing.has(workId)) return { status: "already-syncing" };
    const lease = await this.store.acquireSyncLease(workId);
    if (!lease) return { status: "leased-elsewhere" };
    this.syncing.add(workId);
    await this.store.setWorkStatus(workId, "syncing");
    await this.emitStatus("syncing", workId);
    try {
      const session = await this.request("/api/auth/session");
      if (session.authenticated !== true || session.user?.userId !== this.user.userId) {
        throw new MobileSyncClientError("REMOTE_LOGIN_REQUIRED", "手机端登录已失效，同步队列已暂停");
      }
      const health = await this.request("/api/health");
      if (!rangesOverlap(health.syncProtocol, SYNC_PROTOCOL)) {
        throw new MobileSyncClientError("SYNC_PROTOCOL_INCOMPATIBLE", "当前 Server 版本不支持离线同步，请升级后重试");
      }
      const work = await this.request(`/api/works/${encodeURIComponent(workId)}`);
      if (work.offlineAccessEnabled !== true) throw new MobileSyncClientError("OFFLINE_ACCESS_DISABLED", "作品已关闭离线访问");
      await this.pullWork(workId);
      await this.pushWork(workId);
      const summary = await this.store.statusSummary(workId);
      const finalStatus = summary.rejected > 0 ? "read-only" : summary.conflicts > 0 ? "conflict" : "ready";
      await this.store.setWorkStatus(workId, finalStatus === "conflict" ? "ready" : finalStatus);
      await this.emitStatus(finalStatus, workId);
      return { status: finalStatus, summary };
    } catch (error) {
      const code = error?.code ?? "SYNC_FAILED";
      if (READ_ONLY_ERROR_CODES.has(code)) await this.store.setWorkStatus(workId, "read-only", code);
      else if (code === "REMOTE_LOGIN_REQUIRED" || code === "SYNC_NETWORK_ERROR") await this.store.setWorkStatus(workId, "offline", code);
      else await this.store.setWorkStatus(workId, "error", code);
      await this.emitStatus(READ_ONLY_ERROR_CODES.has(code) ? "read-only" : "failed", workId, error);
      throw error;
    } finally {
      this.syncing.delete(workId);
      await this.store.releaseSyncLease(workId, lease.leaseId);
    }
  }

  async pullWork(workId) {
    const work = await this.store.getWork(workId);
    if (!work) throw new MobileSyncClientError("SYNC_WORK_NOT_FOUND", "离线作品不存在");
    let cursor = Number(work.cursor);
    while (true) {
      const page = await this.request(`/api/sync/works/${encodeURIComponent(workId)}/changes?after=${cursor}&limit=200`);
      await this.store.applyRemoteChanges(workId, page.items, Number(page.nextCursor));
      cursor = Number(page.nextCursor);
      if (!page.hasMore) return cursor;
    }
  }

  async pushWork(workId) {
    const results = [];
    while (true) {
      const batch = await this.store.preparePushBatch(workId, 20);
      if (batch.mutations.length === 0) return results;
      const body = {
        clientId: batch.clientId,
        mutations: batch.mutations.map((mutation) => ({
          ...mutation,
          localSnapshot: syncMutationSnapshot(mutation.entityType, mutation.localSnapshot)
        }))
      };
      try {
        const pushed = await this.request(`/api/sync/works/${encodeURIComponent(workId)}/push`, { method: "POST", body });
        await this.store.applyPushResults(workId, pushed.results);
        results.push(...pushed.results);
      } catch (error) {
        const attempts = Math.max(...batch.mutations.map((mutation) => Number(mutation.attempts ?? 1)), 1);
        if (error?.retryable) {
          const delay = retryDelay(attempts, error.retryAfterSeconds);
          await this.store.returnSyncingToPending(batch.mutationIds, new Date(Date.now() + delay).toISOString());
        } else {
          await this.store.returnSyncingToPending(batch.mutationIds, null);
        }
        throw error;
      }
    }
  }

  async emitStatus(status, workId, error = null) {
    const works = await this.store.listWorks();
    const summaries = await Promise.all(works.map((work) => this.store.statusSummary(work.workId)));
    const aggregate = summaries.reduce((total, summary) => ({
      pendingMutations: total.pendingMutations + summary.pending + summary.syncing,
      conflicts: total.conflicts + summary.conflicts,
      rejected: total.rejected + summary.rejected
    }), { pendingMutations: 0, conflicts: 0, rejected: 0 });
    const detail = { status, workId, ...aggregate, errorCode: error?.code ?? null };
    globalThis.dispatchEvent?.(new CustomEvent("scriverse-mobile-sync-state", { detail }));
    return detail;
  }

  dispose() {
    this.disposed = true;
    globalThis.removeEventListener?.("online", this.handleOnline);
    if (this.pollTimer !== null) globalThis.clearInterval?.(this.pollTimer);
    this.store.close();
  }
}

export async function createMobileSyncClient({
  user,
  profile = null,
  store,
  csrfToken = null,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!user?.userId || !store) return null;
  await store.open();
  await store.recoverSyncing();
  return new MobileSyncClient({ profile, user, store, csrfToken, fetchImpl });
}
