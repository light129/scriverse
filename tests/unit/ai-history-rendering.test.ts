import { describe, expect, it } from "vitest";
import { deferredAiHistoryMessageIndexes, estimateAiHistoryContentHeight } from "../../src/public/ai-conversation.js";

describe("AI 历史消息渐进渲染", () => {
  it("短历史立即完整渲染", () => {
    expect(deferredAiHistoryMessageIndexes(Array.from({ length: 20 }, () => ({ content: "普通回复".repeat(100) })))).toEqual(new Set());
  });

  it("超长历史只立即渲染最新两条，其他正文可按可见范围渲染", () => {
    const messages = Array.from({ length: 20 }, () => ({ content: "历史正文".repeat(30_000) }));
    expect([...deferredAiHistoryMessageIndexes(messages)]).toEqual(Array.from({ length: 18 }, (_, index) => index));
    expect(messages.every((message) => message.content.length === 120_000)).toBe(true);
  });

  it("密集 Markdown 换行同样受渲染预算约束", () => {
    const messages = Array.from({ length: 10 }, () => ({ content: "x\n\n".repeat(1_000) }));
    expect([...deferredAiHistoryMessageIndexes(messages)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("失败和中断消息保持立即可操作", () => {
    const content = "详细正文".repeat(10_000);
    const messages = [{ content: `调用失败：${content}` }, { content, metadata: { interrupted: true } }, { content }, { content }, { content }];
    expect([...deferredAiHistoryMessageIndexes(messages)]).toEqual([2]);
  });

  it("处理异常输入和渲染数量边界", () => {
    expect(deferredAiHistoryMessageIndexes(null)).toEqual(new Set());
    expect(deferredAiHistoryMessageIndexes({ content: "内容" })).toEqual(new Set());
    const messages = [{ content: "正文".repeat(50_000) }, { content: "正文".repeat(50_000) }];
    expect([...deferredAiHistoryMessageIndexes(messages, 0)]).toEqual([0, 1]);
    expect(deferredAiHistoryMessageIndexes(messages, -1)).toEqual(new Set());
  });

  it("高度估算随窄屏增加，并保持有限的安全边界", () => {
    const content = "历史正文。".repeat(20_000);
    expect(estimateAiHistoryContentHeight(content, 160)).toBeGreaterThan(estimateAiHistoryContentHeight(content, 600));
    expect(estimateAiHistoryContentHeight(content, Number.NaN, 0, Number.NaN)).toBeGreaterThan(80);
    expect(estimateAiHistoryContentHeight("x".repeat(2_000_000), 1)).toBe(1_000_000);
    expect(estimateAiHistoryContentHeight("", 300)).toBeGreaterThan(0);
  });
});
