import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./markdown-content";

describe("MarkdownContent", () => {
  it("renders Markdown but skips embedded HTML and unsafe links", () => {
    render(
      <MarkdownContent
        content={
          "**Ready**\n\n<script>window.bad = true</script>\n\n[bad](javascript:alert(1))"
        }
      />
    );

    expect(screen.getByText("Ready").tagName).toBe("STRONG");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("bad")).not.toHaveAttribute(
      "href",
      expect.stringMatching(/^javascript:/)
    );
  });
});
