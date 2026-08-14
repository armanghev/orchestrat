import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AppCommand } from "@/features/command/commands";
import { CommandMenu } from "./command-menu";

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserver);

Element.prototype.scrollIntoView = vi.fn();

function MenuHarness({ run }: { run: AppCommand["run"] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const commands: AppCommand[] = [
    {
      id: "test",
      group: "Application",
      label: "Run test command",
      keywords: [],
      run
    }
  ];
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <CommandMenu
        open={open}
        onOpenChange={setOpen}
        commands={commands}
        triggerRef={triggerRef}
      />
    </>
  );
}

describe("CommandMenu", () => {
  it("closes and restores focus when an async command rejects", async () => {
    const user = userEvent.setup();
    const run = vi.fn(() => Promise.reject(new Error("failed")));
    render(<MenuHarness run={run} />);
    const trigger = screen.getByRole("button", { name: "Open palette" });
    await user.click(trigger);
    await user.click(screen.getByText("Run test command"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(run).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it("closes and restores focus without waiting for a pending command", async () => {
    const user = userEvent.setup();
    const run = vi.fn(() => new Promise<void>(() => {}));
    render(<MenuHarness run={run} />);
    const trigger = screen.getByRole("button", { name: "Open palette" });
    await user.click(trigger);
    await user.click(screen.getByText("Run test command"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(run).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });
});
