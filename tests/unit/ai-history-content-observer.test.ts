import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { estimateAiHistoryContentHeight } from "../../src/public/ai-conversation.js";
import { shouldFollowAiFeedAfterScroll } from "../../src/public/ai-feed-scroll.js";

const application = readFileSync(join(process.cwd(), "src/public/app.js"), "utf8");
const source = application.slice(application.indexOf("function disposeAiHistoryFeed("), application.indexOf("function aiStreamTargetVisible("));

class Classes {
  values = new Set<string>();
  add(...values: string[]): void { values.forEach(value => this.values.add(value)); }
  remove(...values: string[]): void { values.forEach(value => this.values.delete(value)); }
  contains(value: string): boolean { return this.values.has(value); }
  toggle(value: string, enabled: boolean): void { if (enabled) this.add(value); else this.remove(value); }
}

class Element {
  classList = new Classes();
  styles = new Map<string, string>();
  style = { setProperty: (key: string, value: string) => this.styles.set(key, value), removeProperty: (key: string) => this.styles.delete(key) };
  children: Element[] = [];
  className = "";
  text = "";
  html = "";
  clientWidth = 300;
  clientHeight = 700;
  height = 800;
  scrollTop = 100;
  isConnected = true;
  feed: Element | null = null;
  onContentChange: (() => void) | undefined;
  get textContent(): string { return this.text; }
  set textContent(value: string) { this.text = value; this.children = []; this.onContentChange?.(); }
  get innerHTML(): string { return this.html; }
  set innerHTML(value: string) { this.html = value; this.children = []; this.onContentChange?.(); }
  prepend(element: Element): void { this.children.unshift(element); }
  querySelector(selector: string): Element | null {
    if (selector.startsWith(":scope > ")) return this.children.find(element => selector.slice(9) === `.${element.className}`) ?? null;
    for (const child of this.children) {
      if (selector === `.${child.className}`) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  closest(): Element | null { return this.feed; }
  getBoundingClientRect(): { height: number } { return { height: this.height }; }
}

type Entry = { target: Element; isIntersecting: boolean };

function fixture() {
  const observers: Observer[] = [];
  class Observer {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    constructor(readonly callback: (entries: Entry[]) => void) { observers.push(this); }
    emit(entries: Entry[]): void { this.callback(entries); }
  }
  const feed = new Element();
  const message = new Element();
  message.feed = feed;
  const body = new Element();
  body.className = "message-body";
  const text = "完整历史正文。".repeat(5_000);
  body.textContent = text;
  const scene = new Element();
  scene.className = "user-message-scene";
  body.prepend(scene);
  message.children.push(body);
  const process = new Element();
  const thinking = new Element();
  thinking.className = "message-body";
  thinking.textContent = "独立的思考内容";
  process.children.push(thinking);
  message.children.unshift(process);
  const renderers = new WeakMap<Element, unknown>();
  const scrollStates = new WeakMap<Element, boolean>();
  const scrollTops = new WeakMap<Element, number>();
  const frames = new Map<number, () => void>();
  let sequence = 0;
  const markdown = vi.fn((value: string) => `<p>${value}</p>`);
  const references = vi.fn();
  const functions = runInNewContext(`${source}\n({ observeAiHistoryMessage, hydrateAiHistoryMessage, disposeAiHistoryMessage, disposeAiHistoryFeed })`, {
    aiHistoryFeedRenderers: renderers, aiHistoryMessageContents: new WeakMap<Element, unknown>(),
    aiFeedAutoScrollStates: scrollStates, aiFeedLastScrollTops: scrollTops,
    IntersectionObserver: Observer, estimateAiHistoryContentHeight,
    getComputedStyle: () => ({ fontSize: "12px", lineHeight: "18.6px" }),
    $: () => feed,
    renderMarkdown: markdown, replaceAiReferenceMarkers: references,
    window: {
      requestAnimationFrame: (callback: () => void) => { sequence += 1; frames.set(sequence, callback); return sequence; },
      cancelAnimationFrame: (id: number) => frames.delete(id)
    }
  }) as {
    observeAiHistoryMessage: (message: Element, tab: { feed: Element }, text: string, references: unknown[], role: string, deferred: boolean) => void;
    hydrateAiHistoryMessage: (message: Element) => void;
    disposeAiHistoryMessage: (message: Element) => void;
    disposeAiHistoryFeed: (feed: Element) => void;
  };
  const flush = () => {
    const frame = frames.entries().next().value as [number, () => void] | undefined;
    if (frame) { frames.delete(frame[0]); frame[1](); }
  };
  return { ...functions, feed, message, body, scene, thinking, text, observers, frames, renderers, markdown, references, scrollStates, scrollTops, flush };
}

describe("历史正文可见范围渲染", () => {
  it("进入可见范围才解析 Markdown，离开后回收节点并完整恢复内容与场景", () => {
    const test = fixture();
    const references = [{ id: "reference" }];
    test.observeAiHistoryMessage(test.message, { feed: test.feed }, test.text, references, "user", true);
    expect(test.markdown).not.toHaveBeenCalled();
    test.observers[0]!.emit([{ target: test.message, isIntersecting: true }]);
    test.flush();
    expect(test.markdown).toHaveBeenCalledWith(test.text);
    expect(test.references).toHaveBeenCalledWith(test.body, references);
    expect(test.thinking.textContent).toBe("独立的思考内容");
    expect(test.body.children[0]).toBe(test.scene);
    expect(test.message.classList.contains("ai-history-content-pending")).toBe(false);
    test.observers[0]!.emit([{ target: test.message, isIntersecting: false }]);
    expect(test.body.textContent).toBe(test.text);
    expect(test.body.children[0]).toBe(test.scene);
    expect(test.message.styles.get("--ai-history-height")).toBe("800px");
    test.observers[0]!.emit([{ target: test.message, isIntersecting: true }]);
    test.flush();
    expect(test.markdown).toHaveBeenCalledTimes(2);
  });

  it("隐藏或收起的面板不回收正文，保留阅读位置所需的高度", () => {
    const test = fixture();
    test.observeAiHistoryMessage(test.message, { feed: test.feed }, test.text, [], "assistant", false);
    test.observers[0]!.emit([{ target: test.message, isIntersecting: true }]);
    test.feed.clientHeight = 0;
    test.observers[0]!.emit([{ target: test.message, isIntersecting: false }]);
    expect(test.message.classList.contains("ai-history-content-pending")).toBe(false);
  });

  it("只记录正文高度，布局锚定不会恢复用户已取消的自动滚动", () => {
    const test = fixture();
    test.message.height = 1_200;
    test.body.height = 800;
    test.body.onContentChange = () => { test.feed.scrollTop += 17; };
    test.scrollStates.set(test.feed, false);
    test.scrollTops.set(test.feed, test.feed.scrollTop);
    test.observeAiHistoryMessage(test.message, { feed: test.feed }, test.text, [], "assistant", true);
    test.observers[0]!.emit([{ target: test.message, isIntersecting: true }]);
    test.flush();
    expect(shouldFollowAiFeedAfterScroll({ previousScrollTop: test.scrollTops.get(test.feed) ?? test.feed.scrollTop, scrollTop: test.feed.scrollTop, nearBottom: true, shouldFollow: false })).toBe(false);
    test.observers[0]!.emit([{ target: test.message, isIntersecting: false }]);
    expect(test.message.styles.get("--ai-history-height")).toBe("800px");
    expect(shouldFollowAiFeedAfterScroll({ previousScrollTop: test.scrollTops.get(test.feed) ?? test.feed.scrollTop, scrollTop: test.feed.scrollTop + 10, nearBottom: true, shouldFollow: false })).toBe(true);
  });

  it("切换或关闭会话后取消排队渲染，重试消息可以退出历史渲染管理", () => {
    const test = fixture();
    test.observeAiHistoryMessage(test.message, { feed: test.feed }, test.text, [], "assistant", true);
    test.observers[0]!.emit([{ target: test.message, isIntersecting: true }]);
    expect(test.frames.size).toBe(1);
    test.disposeAiHistoryMessage(test.message);
    expect(test.observers[0]!.unobserve).toHaveBeenCalledWith(test.message);
    test.disposeAiHistoryFeed(test.feed);
    expect(test.observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(test.frames.size).toBe(0);
    expect(test.renderers.has(test.feed)).toBe(false);
    test.observers[0]!.emit([{ target: test.message, isIntersecting: true }]);
    test.flush();
    expect(test.markdown).not.toHaveBeenCalled();
  });
});
