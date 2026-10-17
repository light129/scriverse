import { describe, expect, it } from "vitest";

const { syncMutationSnapshot } = await import(new URL("../../src/public/mobile-sync-client.js", import.meta.url).href) as {
  syncMutationSnapshot: (entityType: string, snapshot: Record<string, unknown>) => Record<string, unknown>;
};

describe("手机端章节类型同步", () => {
  it.each(["正文", "番外", "设定", "作者的话", "其他"])("保留章节标记 %s", (chapterType) => {
    expect(syncMutationSnapshot("chapter", { title: "章节", content: "正文内容", chapterType })).toEqual({
      title: "章节",
      content: "正文内容",
      chapterType
    });
  });

  it("将无效章节类型回退为正文", () => {
    expect(syncMutationSnapshot("chapter", { chapterType: "无效类型" }).chapterType).toBe("正文");
  });
});
