import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("超长 AI 历史读取", () => {
  let runtime: Runtime | null = null;
  let sequence = 0;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    sequence = 0;
  });

  function fixture() {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "超长历史验收" });
    return { runtime, workId: String(work.id) };
  }

  function insertMessage(conversationId: string, role: "user" | "assistant", content: string, metadata: string): void {
    sequence += 1;
    runtime!.database.run(
      "INSERT INTO ai_conversation_messages (id, conversation_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      `history-performance-${sequence}`, conversationId, role, content, metadata, "2026-10-01T00:00:00.000Z"
    );
  }

  it("超长历史只返回短预览，不把全部历史元数据搬入应用内存", () => {
    const { runtime, workId } = fixture();
    const longContent = "最新回复包含大量正文。".repeat(20_000);
    const metadata = JSON.stringify({ modelId: "history-model", mentionCharacterIds: Array.from({ length: 200 }, (_, index) => `character-history-${index}`) });
    for (let index = 0; index < 6; index += 1) {
      const conversation = runtime.store.createAiConversation(workId, `历史会话 ${index}`);
      runtime.database.run("UPDATE ai_conversations SET injected_entities_json = ? WHERE id = ?", JSON.stringify({ characters: Array.from({ length: 2_000 }, (_, item) => `cached-character-${item}`) }), String(conversation.id));
      runtime.database.transaction(() => {
        for (let message = 1; message <= 160; message += 1) {
          insertMessage(String(conversation.id), message % 2 ? "user" : "assistant", message === 160 ? longContent : `历史 ${message}`, message % 2 ? metadata : "{}");
        }
      });
    }
    const all = vi.spyOn(runtime.database, "all");
    const page = runtime.store.listAiConversationsPage(workId, { page: 1, limit: 20, offset: 0 });
    expect(page.items).toHaveLength(6);
    for (const conversation of page.items) {
      expect(conversation).toMatchObject({ messageCount: 160, modelId: "history-model", hasCompactedSummary: false });
      expect(Array.from(String(conversation.preview))).toHaveLength(200);
      expect(String(conversation.preview)).toMatch(/^最新回复/u);
    }
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(20_000);
    const materialized = all.mock.results.flatMap(result => result.type === "return" && Array.isArray(result.value) ? result.value : []);
    expect(materialized.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(JSON.stringify(materialized))).toBeLessThan(100_000);
  });

  it("保留首个有效模型和图片锁定语义，并处理空白或异常元数据", () => {
    const { runtime, workId } = fixture();
    const conversation = runtime.store.createAiConversation(workId);
    const conversationId = String(conversation.id);
    for (const metadata of [
      "{", "null", "[]",
      JSON.stringify({ modelId: "\u2003\t", chatImageAttachmentIds: [null, 12, "\u3000"] }),
      JSON.stringify({ modelId: 123, chatImageAttachmentIds: {} }),
      JSON.stringify({ modelId: "\u2003first-model\u00a0" }),
      JSON.stringify({ modelId: "second-model", chatImageAttachmentIds: ["  attachment-one  "] })
    ]) insertMessage(conversationId, "user", "历史用户消息", metadata);
    insertMessage(conversationId, "assistant", "最新回复", JSON.stringify({ modelId: "assistant-model" }));
    const summary = runtime.store.getAiConversationSummary(conversationId);
    expect(summary).toMatchObject({ modelId: "first-model", hasImageAttachments: true, modelLockedByImage: true, preview: "最新回复" });
  });

  it("不将非图片值或空白附件误判为图片", () => {
    const { runtime, workId } = fixture();
    const conversation = runtime.store.createAiConversation(workId);
    insertMessage(String(conversation.id), "user", "无图片消息", JSON.stringify({ chatImageAttachmentIds: [null, 1, "", "\u2003\n"] }));
    expect(runtime.store.getAiConversationSummary(String(conversation.id))).not.toHaveProperty("hasImageAttachments");
  });

  it("长场景和长用户正文的预览不暴露内部标记，完整消息仍能读取", () => {
    const { runtime, workId } = fixture();
    for (const content of [
      `<scene_direction>${"场景描述。".repeat(2_000)}</scene_direction>\n<user_message>用户指令</user_message>`,
      `<scene_direction>夜港</scene_direction>\n<user_message>${"用户指令。".repeat(2_000)}</user_message>`
    ]) {
      const conversation = runtime.store.createAiConversation(workId);
      insertMessage(String(conversation.id), "user", content, "{}");
      const summary = runtime.store.getAiConversationSummary(String(conversation.id));
      expect(String(summary.preview)).not.toContain("<scene_direction>");
      expect(String(summary.preview)).not.toContain("<user_message>");
      expect(Array.from(String(summary.preview))).toHaveLength(200);
      const full = runtime.store.getAiConversationPage(String(conversation.id), { page: 1, limit: 20, offset: 0 });
      expect((full.messages as Array<{ content: string }>)[0]?.content).toBe(content);
    }
  });

  it("对历史列表启用压缩，同时保留独立的完整消息接口", async () => {
    const { runtime, workId } = fixture();
    for (let index = 0; index < 20; index += 1) {
      const conversation = runtime.store.createAiConversation(workId, `用于压缩验证的历史会话 ${index}`);
      insertMessage(String(conversation.id), "assistant", "用于验证预览压缩。".repeat(1_000), "{}");
    }
    const response = await request(runtime.app).get(`/api/works/${workId}/ai-conversations?page=1&limit=20`).set("Accept-Encoding", "gzip").expect(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.body.data.items).toHaveLength(20);
    expect(response.body.data.items[0].preview.length).toBe(200);
  });

  it("消息视图只传输一次完整消息，默认分页且保留旧响应兼容", async () => {
    const { runtime, workId } = fixture();
    const conversation = runtime.store.createAiConversation(workId);
    const conversationId = String(conversation.id);
    const content = "完整历史正文不得截断。".repeat(2_000);
    for (let index = 0; index < 30; index += 1) insertMessage(conversationId, index % 2 ? "assistant" : "user", `${content}${index}`, "{}");
    const lean = await request(runtime.app).get(`/api/ai-conversations/${conversationId}?view=messages`).set("Accept-Encoding", "gzip").expect(200);
    expect(lean.headers["content-encoding"]).toBe("gzip");
    expect(lean.body.data.messagesPage).toEqual({ page: 1, limit: 20, hasMore: true, nextPage: 2 });
    expect(lean.body.data.messages).toHaveLength(20);
    expect(lean.body.data.messages[0].content).toBe(`${content}10`);
    const legacy = await request(runtime.app).get(`/api/ai-conversations/${conversationId}?page=1&limit=20`).expect(200);
    expect(legacy.body.data.messagesPage.items).toEqual(lean.body.data.messages);
    const focused = await request(runtime.app).get(`/api/ai-conversations/${conversationId}?view=messages&limit=1&messageId=history-performance-1`).expect(200);
    expect(focused.body.data.messages).toHaveLength(1);
    expect(focused.body.data.messages[0].content).toBe(`${content}0`);
  });

  it("拒绝无效或重复的消息视图参数", async () => {
    const { runtime, workId } = fixture();
    const conversation = runtime.store.createAiConversation(workId);
    await request(runtime.app).get(`/api/ai-conversations/${String(conversation.id)}?view=unknown`).expect(400);
    await request(runtime.app).get(`/api/ai-conversations/${String(conversation.id)}?view=messages&view=full`).expect(400);
  });
});
