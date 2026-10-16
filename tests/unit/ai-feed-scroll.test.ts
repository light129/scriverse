import { describe, expect, it } from "vitest";
import { shouldFollowAiFeedAfterScroll } from "../../src/public/ai-feed-scroll.js";

describe("AI feed scroll intent", () => {
  it("stops following after any upward movement, including within the bottom threshold", () => {
    expect(shouldFollowAiFeedAfterScroll({
      previousScrollTop: 100,
      scrollTop: 90,
      nearBottom: true,
      shouldFollow: true
    })).toBe(false);
  });

  it("resumes following after downward movement reaches the bottom", () => {
    expect(shouldFollowAiFeedAfterScroll({
      previousScrollTop: 90,
      scrollTop: 100,
      nearBottom: true,
      shouldFollow: false
    })).toBe(true);
  });

  it("keeps manual scrolling paused while moving toward the bottom", () => {
    expect(shouldFollowAiFeedAfterScroll({
      previousScrollTop: 30,
      scrollTop: 45,
      nearBottom: false,
      shouldFollow: false
    })).toBe(false);
  });
});
