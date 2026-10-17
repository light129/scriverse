import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget } from "typescript";
import { describe, expect, it, vi } from "vitest";

const application = createSourceFile("app.js", readFileSync("src/public/app.js", "utf8"), ScriptTarget.Latest, true, ScriptKind.JS);

function declaration(name: string): string {
  const node = application.statements.find((item) => isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error(`Question function is missing: ${name}`);
  return node.getText(application);
}

const submitBinding = application.statements.find((item) => item.getText(application).startsWith('$("#ai-question-submit").addEventListener("click"'));
if (!submitBinding) throw new Error("Question submit binding is missing");

type Draft = { selectedOption: number | null; customAnswer: string };

function fixture(drafts: Draft[], { busy = false, status = "pending", questionCount = drafts.length, index = 0 } = {}) {
  let click = () => {};
  const submit = { disabled: true, title: "", addEventListener: (_type: string, handler: () => void) => { click = handler; } };
  const progress = { textContent: "" };
  const input = { value: drafts[index]?.customAnswer ?? "" };
  let selected = drafts[index]?.selectedOption ?? null;
  const toast = vi.fn();
  const respondAiUserQuestion = vi.fn(async () => undefined);
  const context = {
    aiQuestionDialogQuestionId: "question-1",
    aiQuestionDialogBusy: busy,
    currentAiQuestionDialogView: { status, questions: Array.from({ length: questionCount }, () => ({})) },
    aiQuestionDrafts: drafts,
    aiQuestionDialogIndex: index,
    aiQuestionItems: (question: { questions: unknown[] }) => question.questions,
    $: (selector: string) => {
      if (selector === "#ai-question-submit") return submit;
      if (selector === "#ai-question-progress") return progress;
      if (selector === "#ai-question-custom-answer") return input;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    document: { querySelector: () => selected === null ? null : { value: String(selected) } },
    toast,
    respondAiUserQuestion
  };
  runInNewContext([
    declaration("aiQuestionDraftIsAnswered"),
    declaration("updateCurrentAiQuestionDraft"),
    declaration("syncAiQuestionSubmitState"),
    submitBinding!.getText(application),
    "syncAiQuestionSubmitState();"
  ].join("\n"), context);
  return { submit, progress, input, toast, respondAiUserQuestion, click: () => click(), select: (value: number | null) => { selected = value; } };
}

describe("AI question submission", () => {
  it("shows a toast for a partial batch and preserves the first answer", () => {
    const drafts = [{ selectedOption: 0, customAnswer: "Keep this detail" }, { selectedOption: null, customAnswer: "" }];
    const dialog = fixture(drafts);
    expect(dialog.submit.disabled).toBe(false);
    dialog.click();
    expect(dialog.toast).toHaveBeenCalledExactlyOnceWith("请回答所有问题再提交", "warning");
    expect(dialog.respondAiUserQuestion).not.toHaveBeenCalled();
    expect(drafts[0]).toEqual({ selectedOption: 0, customAnswer: "Keep this detail" });
    expect(dialog.progress.textContent).toBe("问题 1 / 2 · 已回答 1 / 2");
    expect(dialog.submit.title).toBe("还有 1 个问题未回答");
  });

  it.each(["", "   "])("rejects blank custom answers %j", (customAnswer) => {
    const dialog = fixture([{ selectedOption: 0, customAnswer: "" }, { selectedOption: null, customAnswer }], { index: 1 });
    dialog.click();
    expect(dialog.toast).toHaveBeenCalledExactlyOnceWith("请回答所有问题再提交", "warning");
    expect(dialog.respondAiUserQuestion).not.toHaveBeenCalled();
  });

  it("shows the same guidance when no answers are provided", () => {
    const dialog = fixture([{ selectedOption: null, customAnswer: "" }]);
    expect(dialog.submit.disabled).toBe(false);
    dialog.click();
    expect(dialog.toast).toHaveBeenCalledExactlyOnceWith("请回答所有问题再提交", "warning");
    expect(dialog.respondAiUserQuestion).not.toHaveBeenCalled();
  });

  it("reads the current input and submits all answers after the missing answer is filled", () => {
    const dialog = fixture([{ selectedOption: 0, customAnswer: "" }, { selectedOption: null, customAnswer: "" }], { index: 1 });
    dialog.click();
    dialog.input.value = "  Use first person  ";
    dialog.click();
    expect(dialog.respondAiUserQuestion).toHaveBeenCalledExactlyOnceWith("question-1", {
      action: "answer",
      answers: [{ selectedOption: 0 }, { customAnswer: "Use first person" }]
    });
    expect(dialog.toast).toHaveBeenCalledOnce();
  });

  it("submits a complete single-question selection with optional detail", () => {
    const dialog = fixture([{ selectedOption: null, customAnswer: "  Keep the ending  " }]);
    dialog.select(1);
    dialog.click();
    expect(dialog.respondAiUserQuestion).toHaveBeenCalledExactlyOnceWith("question-1", {
      action: "answer",
      answers: [{ selectedOption: 1, customAnswer: "Keep the ending" }]
    });
    expect(dialog.toast).not.toHaveBeenCalled();
  });

  it.each([{ busy: true }, { status: "answered" }, { status: "expired" }])("keeps unavailable submissions disabled for %o", (options) => {
    const dialog = fixture([{ selectedOption: 0, customAnswer: "" }], options);
    expect(dialog.submit.disabled).toBe(true);
    dialog.click();
    expect(dialog.respondAiUserQuestion).not.toHaveBeenCalled();
    expect(dialog.toast).not.toHaveBeenCalled();
  });

  it("rejects drafts that do not cover the complete question batch", () => {
    const dialog = fixture([{ selectedOption: 0, customAnswer: "" }], { questionCount: 2 });
    expect(dialog.submit.disabled).toBe(true);
    dialog.click();
    expect(dialog.respondAiUserQuestion).not.toHaveBeenCalled();
    expect(dialog.toast).toHaveBeenCalledExactlyOnceWith("请回答所有问题再提交", "warning");
  });
});
