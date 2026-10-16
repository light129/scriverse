import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const application = readFileSync(join(process.cwd(), "src/public/app.js"), "utf8");
const source = application.slice(application.indexOf("function beginAiConversationNavigation("), application.indexOf("function aiAssistantRequestId("));

type Navigation = { generation: number; workId: string; signal: AbortSignal };

function fixture() {
  const context = {
    AbortController, aiConversationNavigationController: null,
    aiConversationNavigationGeneration: 0, aiConversationNavigationPending: null,
    state: { work: { id: "work" } },
    aiRequestManager: { hasActive: () => false, cancelAll: vi.fn() },
    syncAiRequestControls: vi.fn(), toast: vi.fn()
  };
  const functions = runInNewContext(`${source}\n({ beginAiConversationNavigation, finishAiConversationNavigation, invalidateAiConversationNavigation, isAiConversationNavigationCurrent })`, context) as {
    beginAiConversationNavigation: (reason: string) => Navigation;
    finishAiConversationNavigation: (navigation: Navigation) => boolean;
    invalidateAiConversationNavigation: (reason: string) => void;
    isAiConversationNavigationCurrent: (navigation: Navigation) => boolean;
  };
  return { context, ...functions };
}

describe("AI 历史切换请求", () => {
  it("连续切换取消旧消息请求，旧响应不能覆盖最新会话", () => {
    const navigation = fixture();
    const first = navigation.beginAiConversationNavigation("first");
    const second = navigation.beginAiConversationNavigation("second");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(navigation.isAiConversationNavigationCurrent(first)).toBe(false);
    expect(navigation.isAiConversationNavigationCurrent(second)).toBe(true);
    expect(navigation.finishAiConversationNavigation(first)).toBe(false);
    expect(navigation.context.aiConversationNavigationPending).toBe(second.generation);
    expect(navigation.finishAiConversationNavigation(second)).toBe(true);
  });

  it("切换作品取消读取，但完成的会话不被误取消", () => {
    const navigation = fixture();
    const first = navigation.beginAiConversationNavigation("first");
    navigation.invalidateAiConversationNavigation("work changed");
    expect(first.signal.aborted).toBe(true);
    const second = navigation.beginAiConversationNavigation("second");
    navigation.finishAiConversationNavigation(second);
    navigation.beginAiConversationNavigation("third");
    expect(second.signal.aborted).toBe(false);
  });

  it("切回缓存会话也会取消尚未完成的冷切换", async () => {
    const navigation = fixture();
    const pending = navigation.beginAiConversationNavigation("pending cold request");
    const activate = vi.fn();
    Object.assign(navigation.context, {
      state: { work: { id: "work" }, aiConversations: [{ id: "cached" }] },
      aiChatTabManager: { findByConversation: () => ({ id: "cached-tab" }) },
      activateAiChatTab: activate,
      setAiHistoryVisible: vi.fn(), scheduleAiHistoryReferences: vi.fn()
    });
    const openSource = application.slice(application.indexOf("async function openAiConversation("), application.indexOf("function focusAiConversationMessage("));
    const open = runInNewContext(`${source}\n${openSource}\nopenAiConversation`, navigation.context) as (id: string) => Promise<unknown>;
    await open("cached");
    expect(pending.signal.aborted).toBe(true);
    expect(navigation.isAiConversationNavigationCurrent(pending)).toBe(false);
    expect(activate).toHaveBeenCalledWith("cached-tab");
  });
});
