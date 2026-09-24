import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

// CSS variables switch themes without recreating CodeMirror and losing selection.
export const codeMirrorExtensions = [
  EditorView.theme({
    "&": { color: "var(--foreground)", backgroundColor: "var(--background)" },
    ".cm-content": { caretColor: "var(--foreground)" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.75" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
    ".cm-gutters": {
      backgroundColor: "var(--card)",
      color: "var(--muted-foreground)",
      borderColor: "var(--border)"
    },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--muted)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "var(--accent)" },
    ".cm-panels, .cm-tooltip": {
      backgroundColor: "var(--popover)",
      color: "var(--foreground)",
      borderColor: "var(--border)"
    },
    ".cm-searchMatch, .cm-selectionMatch, .cm-matchingBracket": {
      backgroundColor: "var(--accent)"
    }
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      {
        tag: [tags.name, tags.punctuation, tags.content],
        color: "var(--foreground)"
      },
      { tag: [tags.keyword, tags.operator], color: "var(--primary-text)" },
      { tag: [tags.literal, tags.typeName], color: "var(--info)" },
      { tag: [tags.comment, tags.meta], color: "var(--muted-foreground)" },
      {
        tag: tags.link,
        color: "var(--primary-text)",
        textDecoration: "underline"
      },
      { tag: tags.heading, color: "var(--foreground)", fontWeight: "600" },
      { tag: tags.strong, color: "var(--foreground)", fontWeight: "700" },
      { tag: tags.emphasis, color: "var(--foreground)", fontStyle: "italic" },
      { tag: tags.invalid, color: "var(--destructive)" }
    ])
  )
];
