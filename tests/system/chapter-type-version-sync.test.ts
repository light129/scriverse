import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const application = readFileSync("src/public/app.js", "utf8");
const start = application.indexOf('$("#chapter-type-menu").addEventListener("click", async (event) => {');
const end = application.indexOf('$("#markdown-table-wrap-toggle").addEventListener', start);

describe("章节标记版本同步", () => {
  it.each([true, false])("标记后更新目录版本且只同步当前章节：%s", async (selected) => {
    const chapter = { id: "chapter-one", chapterType: "正文", versionNo: 1 };
    const context = {
      state: {
        contextChapterId: chapter.id,
        work: { volumes: [{ chapters: [chapter] }] },
        chapter: { id: selected ? chapter.id : "chapter-two", chapterType: "正文", versionNo: 1, content: "Unsaved local content" }
      },
      api: vi.fn().mockResolvedValue({ chapterType: "设定", versionNo: 2, content: "Saved server content" }),
      closeChapterTypeMenu: vi.fn(),
      updateChapterStats: vi.fn(),
      renderTree: vi.fn(),
      toast: vi.fn(),
      $: vi.fn()
    };
    type ClickEvent = { target: { closest: (selector: string) => { dataset: { chapterType: string } } | null } };
    let click: ((event: ClickEvent) => Promise<void>) | undefined;
    context.$.mockReturnValue({ addEventListener: (_type: string, listener: typeof click) => { click = listener; } });
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    runInNewContext(application.slice(start, end), context);
    await click!({ target: { closest: (selector) => selector === "[data-chapter-type]" ? { dataset: { chapterType: "设定" } } : null } });

    expect(context.api).toHaveBeenCalledExactlyOnceWith("/api/chapters/chapter-one", { method: "PATCH", body: { chapterType: "设定" } });
    expect(chapter).toMatchObject({ chapterType: "设定", versionNo: 2 });
    expect(context.state.chapter).toMatchObject({
      chapterType: selected ? "设定" : "正文",
      versionNo: selected ? 2 : 1,
      content: "Unsaved local content"
    });
    expect(context.updateChapterStats).toHaveBeenCalledTimes(selected ? 1 : 0);
  });
});
