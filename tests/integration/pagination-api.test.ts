import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createTestRuntime, createWork } from "../helpers.js";

describe("列表 API 分页", () => {
  it("按页返回作品和设定，并保留下一页标记", async () => {
      const runtime = createTestRuntime();
      try {
        const work = await createWork(runtime);
        await createWork(runtime);
        const workId = String(work.id);
      for (const title of ["设定一", "设定二", "设定三"]) {
        runtime.store.createSetting(workId, { title, category: "规则", content: `${title}内容` });
      }

      const firstPage = await request(runtime.app).get("/api/works?limit=1&page=1").expect(200);
      expect(firstPage.body.data).toMatchObject({ page: 1, limit: 1, hasMore: true, nextPage: 2 });
      expect(firstPage.body.data.items).toHaveLength(1);

      const secondPage = await request(runtime.app).get(`/api/works/${workId}/settings?limit=2&page=2`).expect(200);
      expect(secondPage.body.data).toMatchObject({ page: 2, limit: 2, hasMore: false, nextPage: null });
      expect(secondPage.body.data.items).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("角色分页返回总数", async () => {
    const runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      const workId = String(work.id);
      for (let index = 1; index <= 3; index += 1) {
        runtime.store.createCharacter(workId, { name: `角色${index}` });
      }

      const page = await request(runtime.app).get(`/api/works/${workId}/characters?limit=2&page=2`).expect(200);
      expect(page.body.data).toMatchObject({ page: 2, limit: 2, hasMore: false, nextPage: null, total: 3 });
      expect(page.body.data.items).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("拒绝超出上限或非法的分页参数", async () => {
    const runtime = createTestRuntime();
    try {
      await request(runtime.app).get("/api/works?limit=101").expect(400);
      await request(runtime.app).get("/api/works?page=0").expect(400);
      await request(runtime.app).get("/api/works?page=1&page=2").expect(400);
    } finally {
      await runtime.close();
    }
  });

  it("默认每页 20 条，并完整读取超过两页的章节、角色和 AI 消息", async () => {
    const runtime = createTestRuntime();
    try {
      const work = await createWork(runtime);
      const workId = String(work.id);
      const volume = runtime.store.createVolume(workId, { title: "分页测试" });
      const conversation = runtime.store.createAiConversation(workId);
      for (let index = 1; index <= 45; index += 1) {
        runtime.store.createChapter(workId, { volumeId: String(volume.id), title: `章节 ${index}`, content: "正文" });
        runtime.store.createCharacter(workId, { name: `角色 ${index}` });
        runtime.store.addAiConversationMessage(String(conversation.id), { role: "user", content: `消息 ${index}` });
      }

      for (const path of [
        `/api/volumes/${String(volume.id)}/chapters`,
        `/api/works/${workId}/characters`,
        `/api/ai-conversations/${String(conversation.id)}`
      ]) {
        const ids: string[] = [];
        for (let page = 1; page <= 3; page += 1) {
          const response = await request(runtime.app).get(`${path}?page=${page}`).expect(200);
          const data = response.body.data;
          const pagination = data.messagesPage ?? data;
          const items = data.messages ?? data.items;
          expect(pagination).toMatchObject({ page, limit: 20, hasMore: page < 3, nextPage: page < 3 ? page + 1 : null });
          expect(items).toHaveLength(page < 3 ? 20 : 5);
          ids.push(...items.map((item: { id: string }) => item.id));
        }
        expect(new Set(ids).size).toBe(45);
      }
    } finally {
      await runtime.close();
    }
  });

  it("旧版默认分页跟随 20 条的新默认值，显式定制仍然保留", async () => {
    const runtime = createTestRuntime();
    try {
      const legacy = { characters: 30, analysisTasks: 30, fileVersions: 30 };
      runtime.database.run("UPDATE platform_ui_settings SET page_sizes_json = ? WHERE id = 1", JSON.stringify(legacy));
      const settings = await request(runtime.app).get("/api/ui-settings").expect(200);
      expect(Object.values(settings.body.data.pageSizes)).toEqual(Array(12).fill(20));
      runtime.store.updatePlatformUiSettings({ pageSizes: { characters: 25, analysisTasks: 30 } });
      const custom = await request(runtime.app).get("/api/ui-settings").expect(200);
      expect(custom.body.data.pageSizes).toMatchObject({ characters: 25, analysisTasks: 30, settings: 20 });
      const customized = Object.fromEntries(Object.keys(settings.body.data.pageSizes).map((key) => [key, 30]));
      runtime.store.updatePlatformUiSettings({ pageSizes: customized });
      const customizedDefaults = await request(runtime.app).get("/api/ui-settings").expect(200);
      expect(Object.values(customizedDefaults.body.data.pageSizes)).toEqual(Array(12).fill(30));
    } finally {
      await runtime.close();
    }
  });
});
