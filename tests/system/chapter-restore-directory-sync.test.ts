import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const application = readFileSync("src/public/app.js", "utf8");

describe("章节恢复后的目录同步", () => {
  it("恢复版本后立即将历史标题、字数和章节标记同步到目录", async () => {
    const restored = { id: "chapter-one", title: "Original title", content: "Original content", chapterType: "设定", versionNo: 3, wordCount: 15 };
    const inputs: Record<string, { value: string }> = {
      "#chapter-title": { value: "Current title" },
      "#chapter-content": { value: "Current content" }
    };
    const context = {
      state: { chapter: { ...restored, chapterType: "其他", versionNo: 2 } },
      button: { dataset: { restoreVersion: "1" } },
      chapterContentReadyId: null,
      lastSavedChapterSnapshot: null,
      api: vi.fn().mockResolvedValue(restored),
      mergeChapterDirectoryEntry: vi.fn(),
      syncChapterTreeSelection: vi.fn(),
      resetChapterDraftLineIds: vi.fn(),
      scheduleChapterLineNumbers: vi.fn(),
      updateChapterStats: vi.fn(),
      setSaveState: vi.fn(),
      toast: vi.fn(),
      $: (selector: string) => inputs[selector]
    };
    const start = application.indexOf('      state.chapter = await api(`/api/chapters/${state.chapter.id}/restore`');
    const end = application.indexOf("    } catch (error) {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    await runInNewContext(`(async () => {\n${application.slice(start, end)}\n})()`, context);

    expect(context.api).toHaveBeenCalledExactlyOnceWith("/api/chapters/chapter-one/restore", { method: "POST", body: { versionNo: 1 } });
    expect(context.mergeChapterDirectoryEntry).toHaveBeenCalledExactlyOnceWith(restored);
    expect(context.syncChapterTreeSelection).toHaveBeenCalledOnce();
    expect(inputs["#chapter-title"]?.value).toBe(restored.title);
    expect(inputs["#chapter-content"]?.value).toBe(restored.content);
    expect(context.chapterContentReadyId).toBe(restored.id);
  });
});
