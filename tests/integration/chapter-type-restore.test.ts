import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("章节历史类型恢复", () => {
  let runtime: Runtime;

  beforeEach(() => { runtime = createTestRuntime(); });
  afterEach(() => runtime.close());

  it.each(["正文", "设定", "作者的话", "其他"])("正文未变化时仍恢复历史章节标记 %s", async (chapterType) => {
    const work = await request(runtime.app).post("/api/works").send({ title: "类型恢复作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "保留原始正文。",
      chapterType
    }).expect(201);
    const chapterId = String(chapter.body.data.id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      chapterType: chapterType === "作者的话" ? "其他" : "作者的话",
      expectedVersionNo: 1
    }).expect(200);

    const restored = await request(runtime.app).post(`/api/chapters/${chapterId}/restore`).send({ versionNo: 1, expectedVersionNo: 2 }).expect(200);
    expect(restored.body.data).toMatchObject({ chapterType, versionNo: 3, title: "第一章", content: "保留原始正文。" });
    const versions = await request(runtime.app).get(`/api/chapters/${chapterId}/versions`).expect(200);
    expect(versions.body.data[0]).toMatchObject({ chapterType, versionNo: 3, source: "restore" });
  });
});
