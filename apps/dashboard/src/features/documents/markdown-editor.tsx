import { forwardRef } from "react";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  DiffSourceToggleWrapper,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  MDXEditor,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  frontmatterPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  type ImagePreviewHandler,
  type ImageUploadHandler,
  type MDXEditorMethods
} from "@mdxeditor/editor";

export type { MDXEditorMethods } from "@mdxeditor/editor";

import "@mdxeditor/editor/style.css";
import { useTheme } from "@/features/theme/theme-provider";

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
      {
        backgroundColor: "var(--accent)"
      },
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

type MarkdownEditorProps = {
  markdown: string;
  readOnly: boolean;
  onChange: (markdown: string, initialMarkdownNormalize?: boolean) => void;
  onError: (error: { error: string; source: string }) => void;
  imageUploadHandler: ImageUploadHandler;
  imagePreviewHandler: ImagePreviewHandler;
};

export const MarkdownEditor = forwardRef<MDXEditorMethods, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      markdown,
      readOnly,
      onChange,
      onError,
      imageUploadHandler,
      imagePreviewHandler
    },
    ref
  ) {
    const { resolvedTheme } = useTheme();
    return (
      <MDXEditor
        ref={ref}
        markdown={markdown}
        suppressHtmlProcessing
        readOnly={readOnly}
        onChange={onChange}
        onError={onError}
        contentEditableClassName="document-markdown min-h-[24rem]"
        className={`orchestrat-markdown-editor mdxeditor-full-height h-full ${resolvedTheme === "dark" ? "dark-theme" : ""}`}
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          imagePlugin({ imageUploadHandler, imagePreviewHandler }),
          tablePlugin(),
          thematicBreakPlugin(),
          frontmatterPlugin(),
          codeBlockPlugin({ defaultCodeBlockLanguage: "text" }),
          codeMirrorPlugin({
            codeMirrorExtensions,
            codeBlockLanguages: {
              bash: "Bash",
              css: "CSS",
              html: "HTML",
              javascript: "JavaScript",
              json: "JSON",
              markdown: "Markdown",
              text: "Plain text",
              tsx: "TSX",
              typescript: "TypeScript"
            }
          }),
          diffSourcePlugin({
            viewMode: "rich-text",
            readOnlyDiff: true,
            codeMirrorExtensions
          }),
          markdownShortcutPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <DiffSourceToggleWrapper options={["rich-text", "source"]}>
                <UndoRedo />
                <Separator />
                <BoldItalicUnderlineToggles />
                <BlockTypeSelect />
                <ListsToggle />
                <Separator />
                <CreateLink />
                <InsertImage />
                <InsertTable />
                <InsertThematicBreak />
              </DiffSourceToggleWrapper>
            )
          })
        ]}
      />
    );
  }
);
