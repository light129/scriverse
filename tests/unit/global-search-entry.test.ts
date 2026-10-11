import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget } from "typescript";
import { describe, expect, it, vi } from "vitest";
import { isChapterSearchShortcut, isGlobalSearchShortcut, type KeyboardShortcutEvent } from "../../src/public/keyboard-shortcuts.js";

const application = createSourceFile("app.js", readFileSync("src/public/app.js", "utf8"), ScriptTarget.Latest, true, ScriptKind.JS);

function declaration(name: string): string {
  const node = application.statements.find((item) => isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error(`Search function is missing: ${name}`);
  return node.getText(application);
}

function binding(marker: string): string {
  const node = application.statements.find((item) => item.getText(application).includes(marker));
  if (!node) throw new Error(`Search event binding is missing: ${marker}`);
  return node.getText(application);
}

function searchEntry({ work = true, chapter = false, readable = true, failure = false } = {}) {
  const hidden = new Set<string>(["hidden"]);
  const listeners = new Map<string, (event: unknown) => void>();
  const button = {
    disabled: true,
    addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
    classList: {
      remove: (value: string) => hidden.delete(value),
      toggle: (value: string, enabled: boolean) => enabled ? hidden.add(value) : hidden.delete(value)
    }
  };
  const editor = { classList: { contains: () => !chapter } };
  const openSearchDialog = vi.fn(async () => {
    if (failure) throw new Error("Search is unavailable");
  });
  const openChapterSearchPanel = vi.fn();
  const closeChapterSearchPanel = vi.fn();
  const toast = vi.fn();
  const context = {
    state: { work: work ? { id: "work-1" } : null, chapter: chapter ? { id: "chapter-1" } : null },
    $: (selector: string) => selector === "#editor-view" ? editor : button,
    canReadAggregateContent: () => readable,
    isChapterSearchShortcut,
    isGlobalSearchShortcut,
    openSearchDialog,
    openChapterSearchPanel,
    closeChapterSearchPanel,
    toast,
    document: { addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler) }
  };
  runInNewContext([
    declaration("isChapterSearchContext"),
    declaration("syncTopSearchButton"),
    binding("const globalSearch = isGlobalSearchShortcut(event);"),
    binding('$("#top-search-button").addEventListener("click"'),
    "syncTopSearchButton();"
  ].join("\n"), context);
  return { button, hidden, listeners, openSearchDialog, openChapterSearchPanel, closeChapterSearchPanel, toast };
}

function keyEvent(event: KeyboardShortcutEvent & { repeat?: boolean }) {
  return { ...event, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

describe("Global search entry", () => {
  it.each([false, true])("keeps the top-right button available with chapter context %s", (chapter) => {
    const entry = searchEntry({ chapter });
    expect(entry.hidden.has("hidden")).toBe(false);
    expect(entry.button.disabled).toBe(false);
    entry.listeners.get("click")?.({});
    expect(entry.openSearchDialog).toHaveBeenCalledOnce();
    expect(entry.openChapterSearchPanel).not.toHaveBeenCalled();
  });

  it.each([{ work: false }, { readable: false }])("keeps unavailable searches disabled for %o", (options) => {
    expect(searchEntry(options).button.disabled).toBe(true);
  });

  it.each([false, true])("opens work-wide search on Ctrl+E with chapter context %s", (chapter) => {
    const entry = searchEntry({ chapter });
    const event = keyEvent({ key: "e", ctrlKey: true });
    entry.listeners.get("keydown")?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(entry.openSearchDialog).toHaveBeenCalledOnce();
    expect(entry.openChapterSearchPanel).not.toHaveBeenCalled();
  });

  it("uses Command/Ctrl+F only in the chapter editor", () => {
    const chapter = searchEntry({ chapter: true });
    chapter.listeners.get("keydown")?.(keyEvent({ key: "f", metaKey: true }));
    expect(chapter.openChapterSearchPanel).toHaveBeenCalledOnce();
    expect(chapter.openSearchDialog).not.toHaveBeenCalled();
    const module = searchEntry();
    const event = keyEvent({ key: "f", ctrlKey: true });
    module.listeners.get("keydown")?.(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(module.openSearchDialog).not.toHaveBeenCalled();
    expect(module.openChapterSearchPanel).not.toHaveBeenCalled();
  });

  it("ignores Ctrl+E outside a work and repeated key presses", () => {
    const shelf = searchEntry({ work: false });
    const event = keyEvent({ key: "e", ctrlKey: true });
    shelf.listeners.get("keydown")?.(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(shelf.openSearchDialog).not.toHaveBeenCalled();
    const entry = searchEntry({ chapter: true });
    entry.listeners.get("keydown")?.(keyEvent({ key: "e", ctrlKey: true, repeat: true }));
    expect(entry.openSearchDialog).not.toHaveBeenCalled();
    expect(entry.openChapterSearchPanel).not.toHaveBeenCalled();
  });

  it("reports a failed search through the existing error toast", async () => {
    const entry = searchEntry({ failure: true });
    entry.listeners.get("click")?.({});
    await Promise.resolve();
    expect(entry.toast).toHaveBeenCalledExactlyOnceWith("Search is unavailable", "error");
  });
});
