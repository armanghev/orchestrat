import { forwardRef } from "react";
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
import { EditorView } from "@codemirror/view";

export type { MDXEditorMethods } from "@mdxeditor/editor";

import "@mdxeditor/editor/style.css";
import { useTheme } from "@/features/theme/theme-provider";
import { codeMirrorExtensions } from "./codemirror-theme";

const sourceEditorExtensions = [
  ...codeMirrorExtensions,
  EditorView.contentAttributes.of({ "aria-label": "Markdown source" })
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
            codeMirrorExtensions: sourceEditorExtensions
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
