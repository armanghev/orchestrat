import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, readTheme, resolveTheme } from "./theme";

afterEach(() => {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("theme", () => {
  it("resolves system and rejects corrupt saved values", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    localStorage.setItem("orchestrat.theme", "orange");
    expect(readTheme(localStorage)).toBe("system");
  });

  it("applies a resolved theme and writes the synchronous mirror", () => {
    applyTheme("system", true, localStorage);
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("orchestrat.theme")).toBe("system");
  });
});
