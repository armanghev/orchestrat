import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownContent({
  content,
  empty = "No description."
}: {
  content: string | null | undefined;
  empty?: string;
}) {
  if (!content?.trim())
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="document-markdown overflow-x-auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
