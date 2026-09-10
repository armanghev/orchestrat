import { useEffect, useRef } from "react";
import { markdown } from "@codemirror/lang-markdown";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { codeMirrorExtensions } from "./markdown-editor";

type DocumentDiffProps = {
  original: string;
  current: string;
};

export function DocumentDiff({ original, current }: DocumentDiffProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: current,
        extensions: [
          lineNumbers(),
          markdown(),
          codeMirrorExtensions,
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({
            "aria-label": "Revision comparison",
            "aria-readonly": "true",
            role: "textbox",
            tabindex: "0"
          }),
          EditorView.theme({
            ".cm-deletedChunk, .cm-deletedLine": {
              backgroundColor:
                "color-mix(in oklch, var(--destructive) 13%, transparent)"
            },
            "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine, .cm-insertedLine":
              {
                backgroundColor:
                  "color-mix(in oklch, var(--success) 13%, transparent)"
              },
            ".cm-deletedChunk .cm-deletedText": {
              backgroundColor:
                "color-mix(in oklch, var(--destructive) 28%, transparent)"
            },
            "&.cm-merge-b .cm-changedText": {
              backgroundColor:
                "color-mix(in oklch, var(--success) 28%, transparent)"
            },
            ".cm-deletedLineGutter": { background: "var(--destructive)" },
            ".cm-changedLineGutter": { background: "var(--success)" }
          }),
          unifiedMergeView({
            original,
            gutter: true,
            mergeControls: false
          })
        ]
      })
    });

    return () => view.destroy();
  }, [current, original]);

  return (
    <div
      ref={containerRef}
      className="document-revision-diff min-h-0 overflow-auto rounded-lg border bg-background"
    />
  );
}
