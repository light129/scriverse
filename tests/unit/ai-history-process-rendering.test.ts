import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const application = readFileSync(join(process.cwd(), "src/public/app.js"), "utf8");
const source = application.slice(application.indexOf("function shouldRenderAiProcessStep("), application.indexOf("function renderAiToolCalls("));

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  className = "";
  textContent = "";
  open = false;
  dataset: Record<string, string> = {};
  listeners = new Map<string, () => void>();
  get lastElementChild(): Element | undefined { return this.children.at(-1); }
  append(...elements: Element[]): void { for (const element of elements) { element.parent = this; this.children.push(element); } }
  before(element: Element): void { this.parent?.insertBefore(element, this); }
  insertBefore(element: Element, before: Element | null): void { element.parent = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, element); }
  remove(): void { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  querySelector(selector: string): Element | null { return this.children.find((element) => selector === ".message-body" && element.className === "message-body") ?? null; }
  addEventListener(type: string, listener: () => void): void { this.listeners.set(type, listener); }
  fire(type: string): void { this.listeners.get(type)?.(); }
}

type Step = { id: string; type: string; content?: string; toolCall?: { pending?: boolean } };

function fixture() {
  const message = new Element();
  const body = new Element();
  body.className = "message-body";
  message.append(body);
  const states = new WeakMap<Element, { details: Element; list: Element; deferred: boolean }>();
  const renderMarkdown = vi.fn();
  const toolButton = vi.fn(() => new Element());
  const render = runInNewContext(`${source}\nrenderAiProcessSteps`, {
    aiProcessRenderStates: states,
    document: { createElement: () => new Element() },
    formatAiProcessDuration: String,
    isInteractiveToolPending: (tool: { pending?: boolean } | undefined) => tool?.pending === true,
    updateAiMarkdown: renderMarkdown,
    createAiToolCallButton: toolButton,
    createAiContextCompactionDivider: () => new Element(),
    scrollAiProcessStepsToBottom: vi.fn()
  }) as (message: Element, steps: Step[], completed: boolean) => void;
  return { message, states, render, renderMarkdown, toolButton };
}

describe("历史执行过程按需渲染", () => {
  it("折叠的长执行过程不解析正文，展开后完整渲染且保持展开", () => {
    const { message, states, render, renderMarkdown } = fixture();
    const steps = [{ id: "one", type: "thinking", content: "长思考".repeat(20_000) }, { id: "two", type: "intermediate", content: "长中间输出".repeat(20_000) }];
    render(message, steps, true);
    const state = states.get(message)!;
    expect(state.details.open).toBe(false);
    expect(state.list.children).toHaveLength(0);
    expect(renderMarkdown).not.toHaveBeenCalled();
    state.details.open = true;
    state.details.fire("toggle");
    expect(state.details.open).toBe(true);
    expect(state.list.children).toHaveLength(2);
    expect(renderMarkdown).toHaveBeenCalledTimes(2);
    state.details.open = false;
    state.details.fire("toggle");
    state.details.open = true;
    state.details.fire("toggle");
    expect(renderMarkdown).toHaveBeenCalledTimes(2);
  });

  it("流式过程即时渲染，结束后保持既有收起行为", () => {
    const { message, states, render, renderMarkdown } = fixture();
    const steps = [{ id: "one", type: "thinking", content: "正在思考" }];
    render(message, steps, false);
    expect(states.get(message)?.details.open).toBe(true);
    expect(renderMarkdown).toHaveBeenCalledOnce();
    render(message, steps, true);
    expect(states.get(message)?.details.open).toBe(false);
  });

  it("待确认的交互卡片仍立即展开并保留操作入口", () => {
    const { message, states, render, toolButton } = fixture();
    render(message, [{ id: "pending", type: "tool", toolCall: { pending: true } }], true);
    expect(states.get(message)?.details.open).toBe(true);
    expect(states.get(message)?.list.children).toHaveLength(1);
    expect(toolButton).toHaveBeenCalledOnce();
  });
});
