import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("窄屏创作助手面板手势", () => {
  it("标题栏向下拖动时收起面板，交互控件和对话工作台不受影响", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(application).toContain("function setupMobileAiPanelSwipeDismiss()");
    expect(application).toContain('event.target.closest("button, input, select, textarea, a")');
    expect(application).toContain("const shouldCollapse = deltaY >= 72 && deltaY > Math.abs(deltaX) * 1.2");
    expect(application).toContain("setupMobileAiPanelSwipeDismiss();");
    expect(application).toContain("panelLayout.aiCollapsed = true;");
    expect(page).toContain("feature=ai-panel-swipe-dismiss-v1");
    expect(styles).toContain(".ai-panel:not(.is-conversation-workspace) .ai-heading { touch-action: pan-x; }");
  });
});
