export function shouldShowAiQuickActions(hasSentPrompt) {
  return !Boolean(hasSentPrompt);
}

export function deferredAiHistoryMessageIndexes(messages, eagerCount = 2) {
  if (!Array.isArray(messages)) return new Set();
  const costs = messages.map((message) => {
    const content = String(message?.content ?? "");
    const lines = content.match(/\n/gu)?.length ?? 0;
    return { content, lines, cost: content.length + lines * 40 };
  });
  if (costs.reduce((sum, item) => sum + item.cost, 0) <= 80_000) return new Set();
  const eager = Number.isSafeInteger(eagerCount) && eagerCount >= 0 ? eagerCount : 2;
  return new Set(costs.flatMap((item, index) => (
    index < messages.length - eager
      && (item.content.length > 8_000 || item.lines > 150)
      && !item.content.startsWith("调用失败：")
      && messages[index]?.metadata?.interrupted !== true
      ? [index] : []
  )));
}

export function estimateAiHistoryContentHeight(content, width, fontSize = 12, lineHeight = 18.6) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 240;
  const safeFontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 12;
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : safeFontSize * 1.55;
  const columns = Math.max(8, Math.floor(safeWidth / safeFontSize));
  const lines = String(content ?? "").split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0);
  return Math.max(80, Math.min(1_000_000, Math.ceil(lines * safeLineHeight + 100)));
}
