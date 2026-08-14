import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

function primitiveSource(name: string) {
  return readFileSync(join(process.cwd(), "src/components/ui", name), "utf8");
}

describe("UI primitive class contracts", () => {
  it("uses explicit open and closed state variants for dialog and sheet", () => {
    for (const name of ["dialog.tsx", "sheet.tsx"]) {
      const source = primitiveSource(name);
      expect(source).toContain("data-[state=open]:");
      expect(source).toContain("data-[state=closed]:");
      expect(source).not.toMatch(/data-(?:open|closed):/);
    }
  });

  it("uses explicit orientation variants and a horizontal separator default", () => {
    const scrollArea = primitiveSource("scroll-area.tsx");
    const separator = primitiveSource("separator.tsx");

    expect(scrollArea).toContain("data-[orientation=horizontal]:");
    expect(scrollArea).toContain("data-[orientation=vertical]:");
    expect(separator).toContain("data-[orientation=horizontal]:h-px");
    expect(separator).toContain("data-[orientation=vertical]:w-px");
    expect(`${scrollArea}${separator}`).not.toMatch(/data-(?:horizontal|vertical):/);
  });

  it("uses true-valued cmdk selection variants", () => {
    const command = primitiveSource("command.tsx");

    expect(command).toContain("data-[selected=true]:");
    expect(command).toContain("group-data-[selected=true]/command-item:");
    expect(command).not.toContain(["data", "selected:"].join("-"));
    expect(command).not.toContain(["group", "data", "selected:"].join("-"));
  });


  it("uses explicit state variants for dropdown menus and tooltips", () => {
    const dropdownMenu = primitiveSource("dropdown-menu.tsx");
    const tooltip = primitiveSource("tooltip.tsx");

    expect(dropdownMenu).toContain("data-[state=open]:animate-in");
    expect(dropdownMenu).toContain("data-[state=closed]:animate-out");
    expect(dropdownMenu).toContain("data-[state=open]:bg-accent");
    expect(tooltip).toContain("data-[state=instant-open]:animate-in");
    expect(tooltip).toContain("data-[state=delayed-open]:animate-in");
    expect(tooltip).toContain("data-[state=closed]:animate-out");
    expect(`${dropdownMenu}${tooltip}`).not.toMatch(/data-(?:open|closed):/);
  });

  it("gives destructive buttons an opaque, semantic high-contrast surface", () => {
    const destructive = buttonVariants({ variant: "destructive" });

    expect(destructive).toContain("bg-destructive");
    expect(destructive).toContain("text-destructive-foreground");
    expect(destructive).not.toContain("bg-destructive/10");
  });
});
