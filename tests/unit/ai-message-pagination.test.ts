import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const application = readFileSync(join(process.cwd(), "src/public/app.js"), "utf8");
const pageLimit = application.match(/^const aiConversationMessagePageLimit = \d+;/mu)?.[0];
const source = application.slice(
  application.indexOf("function renderAiConversationMessagePagination("),
  application.indexOf("function applyConversationToAiChatTab(")
);

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  parentElement: Element | null = null;
  scrollTop = 0;
  get scrollHeight(): number { return this.children.length * 100; }
  append(element: Element): void { element.parentElement = this; this.children.push(element); }
  prepend(element: Element): void { element.parentElement = this; this.children.unshift(element); }
  insertBefore(element: Element, before: Element | null): void {
    element.parentElement = this;
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, element);
  }
  remove(): void {
    const siblings = this.parentElement?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
  }
  setAttribute(): void {}
  addEventListener(): void {}
  querySelectorAll(selector: string): Element[] {
    const key = selector === "[data-message-id]" ? "messageId" : "aiMessagePagination";
    return this.children.filter((element) => key in element.dataset);
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
}

type Conversation = {
  workId: string;
  messages: Array<{ id: string; role: string; content: string }>;
  messagesPage: { page: number; limit: number; hasMore: boolean; nextPage: number | null };
};

function messages(start: number, end: number): Conversation["messages"] {
  return Array.from({ length: end - start + 1 }, (_, index) => ({ id: `message-${start + index}`, role: "user", content: String(start + index) }));
}

function fixture() {
  const feed = new Element();
  for (const message of messages(26, 45)) {
    const element = new Element();
    element.dataset.messageId = message.id;
    feed.append(element);
  }
  const tab = {
    id: "tab", workId: "work", conversationId: "conversation", feed,
    messageHistoryGeneration: 1, messagePageLoading: false,
    messagesPage: { page: 1, limit: 20, hasMore: true, nextPage: 2 },
    composer: { text: "未发送的输入" }
  };
  const api = vi.fn(async (): Promise<Conversation> => ({
    workId: "work", messages: messages(6, 25),
    messagesPage: { page: 2, limit: 20, hasMore: true, nextPage: 3 }
  }));
  const state = { work: { id: "work" } };
  const manager = { get: vi.fn(() => tab) };
  const functions = runInNewContext(`${pageLimit}\n${source}\n({ loadAiConversationMessagePage, renderAiConversationMessages })`, {
    api, state, aiChatTabManager: manager,
    aiRequestManager: { hasActive: () => false },
    document: { createElement: () => new Element() },
    aiFeedAutoScrollStates: new WeakMap(),
    scrollAiFeedToBottom: vi.fn(),
    renderConversationCompactionDivider: vi.fn(),
    resetAiFeed: (target: Element) => { target.children = []; },
    appendMessage: (_role: string, _content: string, _citations: unknown, _createdAt: unknown, _metadata: unknown, id: string, options: { tab: { feed: Element } }) => {
      const element = new Element();
      element.dataset.messageId = id;
      options.tab.feed.append(element);
    }
  }) as {
    loadAiConversationMessagePage: (targetTab: typeof tab, page: number, prepend?: boolean) => Promise<void>;
    renderAiConversationMessages: (targetTab: typeof tab, conversation: Conversation) => void;
  };
  return { api, tab, feed, manager, state, ...functions };
}

describe("AI 消息分页", () => {
  it("每次追加 20 条更早消息，保留消息顺序、滚动位置和未发送输入", async () => {
    const { api, tab, feed, loadAiConversationMessagePage } = fixture();
    feed.scrollTop = 300;
    await loadAiConversationMessagePage(tab, 2, true);
    expect(api).toHaveBeenCalledWith("/api/ai-conversations/conversation?page=2&limit=20&view=messages");
    expect(feed.querySelectorAll("[data-message-id]").map((element) => element.dataset.messageId)).toEqual(messages(6, 45).map((message) => message.id));
    expect(feed.scrollTop).toBe(2_300);
    expect(tab.composer.text).toBe("未发送的输入");
    expect(tab.messagePageLoading).toBe(false);
  });

  it("过滤并发追加导致的重复记录，最后一页后移除加载入口", async () => {
    const { api, tab, feed, loadAiConversationMessagePage } = fixture();
    api.mockResolvedValueOnce({ workId: "work", messages: messages(10, 29), messagesPage: { page: 2, limit: 20, hasMore: true, nextPage: 3 } });
    await loadAiConversationMessagePage(tab, 2, true);
    api.mockResolvedValueOnce({ workId: "work", messages: messages(1, 9), messagesPage: { page: 3, limit: 20, hasMore: false, nextPage: null } });
    await loadAiConversationMessagePage(tab, 3, true);
    expect(feed.querySelectorAll("[data-message-id]").map((element) => element.dataset.messageId)).toEqual(messages(1, 45).map((message) => message.id));
    expect(feed.querySelector("[data-ai-message-pagination]")).toBeNull();
  });

  it("请求失败后允许重试，且不会清空已加载消息", async () => {
    const { api, tab, feed, loadAiConversationMessagePage } = fixture();
    api.mockRejectedValueOnce(new Error("Request failed"));
    await expect(loadAiConversationMessagePage(tab, 2, true)).rejects.toThrow("Request failed");
    expect(tab.messagePageLoading).toBe(false);
    expect(feed.querySelectorAll("[data-message-id]")).toHaveLength(20);
    await loadAiConversationMessagePage(tab, 2, true);
    expect(feed.querySelectorAll("[data-message-id]")).toHaveLength(40);
  });

  it("拒绝将其他作品的响应插入当前会话", async () => {
    const { api, tab, feed, loadAiConversationMessagePage } = fixture();
    api.mockResolvedValueOnce({ workId: "other", messages: messages(6, 25), messagesPage: { page: 2, limit: 20, hasMore: true, nextPage: 3 } });
    await expect(loadAiConversationMessagePage(tab, 2, true)).rejects.toThrow("AI 对话不属于当前作品");
    expect(feed.querySelectorAll("[data-message-id]")).toHaveLength(20);
    expect(tab.messagePageLoading).toBe(false);
  });

  it.each(["reload", "work", "close"])("%s 后丢弃旧响应，并阻止重复加载", async (change) => {
    const { api, tab, feed, manager, state, loadAiConversationMessagePage } = fixture();
    let resolve!: (value: Conversation) => void;
    api.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = loadAiConversationMessagePage(tab, 2, true);
    await loadAiConversationMessagePage(tab, 2, true);
    expect(api).toHaveBeenCalledOnce();
    if (change === "reload") tab.messageHistoryGeneration += 1;
    if (change === "work") state.work.id = "other";
    if (change === "close") manager.get.mockReturnValue(null as unknown as typeof tab);
    resolve({ workId: "work", messages: messages(6, 25), messagesPage: { page: 2, limit: 20, hasMore: true, nextPage: 3 } });
    await pending;
    expect(feed.querySelectorAll("[data-message-id]")).toHaveLength(20);
  });

  it("返回最新消息时保留输入内容", async () => {
    const { tab, feed, loadAiConversationMessagePage, api } = fixture();
    api.mockResolvedValueOnce({ workId: "work", messages: messages(26, 45), messagesPage: { page: 1, limit: 20, hasMore: true, nextPage: 2 } });
    await loadAiConversationMessagePage(tab, 1);
    expect(feed.querySelectorAll("[data-message-id]").map((element) => element.dataset.messageId)).toEqual(messages(26, 45).map((message) => message.id));
    expect(tab.composer.text).toBe("未发送的输入");
    expect(tab.messagePageLoading).toBe(false);
  });
});
