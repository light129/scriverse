import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const application = readFileSync(join(process.cwd(), "src/public/app.js"), "utf8");
const helpers = application.slice(
  application.indexOf("async function apiPage("),
  application.indexOf("function invalidateModuleRequestsAfterMutation(")
);

type Page = { items: number[]; page: number; limit: number; hasMore: boolean; nextPage: number | null };
type PaginationHelpers = {
  apiPage: (path: string, page?: number, limit?: number) => Promise<Page>;
  apiAllPages: (path: string, limit?: number) => Promise<number[]>;
  moduleApiPage: (module: string, path: string, page?: number, limit?: number) => Promise<Page>;
  moduleApiAllPages: (module: string, path: string, limit?: number) => Promise<number[]>;
};

function fixture() {
  const items = Array.from({ length: 45 }, (_, index) => index + 1);
  const api = vi.fn(async (path: string): Promise<Page> => {
    const url = new URL(path, "http://localhost");
    const page = Number(url.searchParams.get("page"));
    const limit = Number(url.searchParams.get("limit"));
    return {
      items: items.slice((page - 1) * limit, page * limit),
      page,
      limit,
      hasMore: page * limit < items.length,
      nextPage: page * limit < items.length ? page + 1 : null
    };
  });
  const functions = runInNewContext(`${helpers}\n({ apiPage, apiAllPages, moduleApiPage, moduleApiAllPages })`, {
    api,
    state: { work: { id: "work" } },
    moduleRequestCache: { request: (_work: string, _module: string, _key: string, loader: () => Promise<unknown>) => loader() }
  }) as PaginationHelpers;
  return { api, functions, items };
}

describe("浏览器列表请求分页", () => {
  it("普通列表和模块列表默认每页请求 20 条并保留原有筛选参数", async () => {
    const { api, functions } = fixture();
    const page = await functions.apiPage("/api/works?scope=all", 2);
    expect(page.items).toHaveLength(20);
    expect(page.items[0]).toBe(21);
    await functions.moduleApiPage("characters", "/api/works/work/characters");
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      "/api/works?scope=all&page=2&limit=20",
      "/api/works/work/characters?page=1&limit=20"
    ]);
  });

  it.each(["apiAllPages", "moduleApiAllPages"] as const)("%s 以 20 条分批读取全部记录，不遗漏最后一页", async (helper) => {
    const { api, functions, items } = fixture();
    const result = helper === "apiAllPages"
      ? await functions.apiAllPages("/api/volumes/volume/chapters")
      : await functions.moduleApiAllPages("characters", "/api/volumes/volume/chapters");
    expect(result).toEqual(items);
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      "/api/volumes/volume/chapters?page=1&limit=20",
      "/api/volumes/volume/chapters?page=2&limit=20",
      "/api/volumes/volume/chapters?page=3&limit=20"
    ]);
  });

  it("保留管理员显式配置的分页数量", async () => {
    const { functions } = fixture();
    expect((await functions.moduleApiPage("characters", "/api/characters", 1, 25)).items).toHaveLength(25);
  });

  it("IM 会话首批和继续加载都请求 20 条，保留游标后的记录", async () => {
    const im = readFileSync(join(process.cwd(), "src/public/im.js"), "utf8");
    const source = im.slice(im.indexOf("  async function refreshConversations("), im.indexOf("  function upsertConversationSummary("));
    const items = Array.from({ length: 25 }, (_, index) => ({ id: String(index) }));
    const api = vi.fn(async (path: string) => {
      const url = new URL(path, "http://localhost");
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit"));
      return { items: items.slice(cursor, cursor + limit), nextCursor: cursor + limit < items.length ? cursor + limit : null, unreadCount: 0 };
    });
    const functions = runInNewContext(`
      let conversationListRequest = 0, unreadRequest = 0, conversationUnreadTotal = 0;
      let conversations = [], current = null, conversationNextCursor = null, conversationPageLoading = false;
      ${source}
      ({ refreshConversations, loadMoreConversations, items: () => conversations })
    `, {
      api,
      array: (value: unknown) => Array.isArray(value) ? value : [],
      renderUnread: vi.fn(),
      renderConversationList: vi.fn()
    }) as { refreshConversations: () => Promise<void>; loadMoreConversations: () => Promise<void>; items: () => typeof items };
    await functions.refreshConversations();
    expect(functions.items()).toHaveLength(20);
    await functions.loadMoreConversations();
    expect(functions.items()).toEqual(items);
    await functions.loadMoreConversations();
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      "/api/im/conversations?limit=20",
      "/api/im/conversations?limit=20&cursor=20"
    ]);
  });
});
