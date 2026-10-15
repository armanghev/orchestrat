import { loader } from "fumadocs-core/source";
import { docs } from "../../.source";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource()
});

/** Docs pages in sidebar order, for the sitemap and llms.txt. */
export function docsPages() {
  const order = source.pageTree.children.flatMap((node) =>
    node.type === "page" ? [node.url] : []
  );
  return source
    .getPages()
    .sort((a, b) => order.indexOf(a.url) - order.indexOf(b.url));
}

/** Plain text of an MDX page for llms-full.txt: no frontmatter, comments or JSX. */
export function mdxToText(raw: string) {
  return raw
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}\n?/g, "")
    .replace(
      /<Draft\s*\/>/g,
      "> Draft: this describes v1, which is still being built."
    )
    .replace(/<Callout[^>]*>/g, "")
    .replace(/<\/Callout>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
