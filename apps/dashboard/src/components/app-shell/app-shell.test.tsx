import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Platform } from "@/platform/contract";
import { PlatformProvider } from "@/platform/provider";
import { PreferencesProvider } from "@/platform/preferences-provider";
import { ThemeProvider } from "@/features/theme/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import { organization, project, workspace } from "@/test/factories";
import { AppShell } from "./app-shell";

class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal("ResizeObserver", ResizeObserver);
Element.prototype.scrollIntoView = vi.fn();

const ids = ["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012", "00000000-0000-4000-8000-000000000013"];
const catalog: ProjectCatalog = { failures: [], projects: ids.map((id, index) => ({ organization: organization(), workspace: workspace(), project: project({ id, name: ["Alpha Project", "Beta", "Gamma"][index] }) })) };
function renderShell(overrides: Partial<Parameters<typeof AppShell>[0]> = {}, initialPreferences = { theme: "system" as const, railMode: "projects" as const, pinnedProjectIds: [ids[0]], recentProjectIds: [ids[1], ids[2]], contextSidebarCollapsed: false }) {
 const platform: Platform = { kind: "desktop", preferences: { load: vi.fn(), save: vi.fn(async () => undefined) }, openExternal: vi.fn(), onAuthCallback: vi.fn(async () => () => undefined) };
 const props = { catalog, activeProjectId: ids[1], navigateToProject: vi.fn(), navigateToRoute: vi.fn(), openPreferences: vi.fn(), signOut: vi.fn(), children: <p>Body</p>, ...overrides };
 return { ...render(<PlatformProvider value={platform}><PreferencesProvider initialPreferences={initialPreferences}><ThemeProvider><TooltipProvider><AppShell {...props} /></TooltipProvider></ThemeProvider></PreferencesProvider></PlatformProvider>), props, platform };
}
describe("AppShell", () => {
 it("provides an accessible rail, sidebar, command shortcut, collapse and drag-safe toolbar", async () => {
   const user = userEvent.setup(); const view = renderShell();
   expect(screen.getByRole("complementary", { name: "Projects" })).toBeInTheDocument();
   expect(screen.getByRole("link", { name: "Open Beta" })).toHaveAttribute("aria-current", "page");
   expect(screen.getByRole("link", { name: "Open Beta" }).className).toContain("focus-visible:ring");
   expect(screen.getAllByRole("button", { name: /Overview|Tasks|Agents|Documents|Messages|Activity|Integrations|Settings/ })).toHaveLength(8);
   const dragRegion = document.querySelector<HTMLElement>("[data-tauri-drag-region]");
   expect(dragRegion).toHaveAttribute("data-slot", "toolbar-drag-region");
   expect(dragRegion?.parentElement).toHaveRole("banner");
   expect(dragRegion).toHaveClass("absolute", "inset-0");
   expect(dragRegion?.querySelectorAll("button, a, input")).toHaveLength(0);
   expect(screen.getByRole("button", { name: /Command/ })).not.toHaveAttribute("data-tauri-drag-region");
   await user.keyboard("{Meta>}k{/Meta}");
   expect(screen.getByPlaceholderText("Search commands…")).toBeInTheDocument();
   await user.keyboard("{Escape}");
   expect(screen.getByRole("button", { name: /Command/ })).toHaveFocus();
   await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
   expect(screen.getByRole("button", { name: "Restore sidebar" })).toBeInTheDocument();
   const alpha = screen.getByRole("link", { name: "Open Alpha Project" });
   expect(alpha).toHaveAttribute("href", `/projects/${ids[0]}/overview`);
   expect(fireEvent.click(alpha, { metaKey: true })).toBe(true);
   expect(view.props.navigateToProject).not.toHaveBeenCalled();
   expect(screen.getByRole("complementary", { name: "Projects" })).toHaveClass("bg-rail");
   await user.click(screen.getByRole("button", { name: "Project options for Alpha Project" }));
   expect(screen.getByRole("menuitem", { name: "Unpin project" })).toBeInTheDocument();
 });
 it("opens the project-local pin action from a project mark context menu", () => {
   renderShell();
   fireEvent.contextMenu(screen.getByRole("link", { name: "Open Alpha Project" }));
   expect(screen.getByRole("menuitem", { name: "Unpin project" })).toBeInTheDocument();
 });
 it("records a selected project with clean ordered pins and recents", async () => {
   const user = userEvent.setup();
   const view = renderShell({}, { theme: "system", railMode: "projects", pinnedProjectIds: [ids[0], "missing", ids[0]], recentProjectIds: [ids[0], ids[1], "missing", ids[1]], contextSidebarCollapsed: false });
   await user.keyboard("{Meta>}k{/Meta}");
   await user.click(screen.getByText("Open Gamma"));
   await waitFor(() => expect(view.platform.preferences.save).toHaveBeenCalled());
   expect(view.platform.preferences.save).toHaveBeenLastCalledWith(expect.objectContaining({ pinnedProjectIds: [ids[0]], recentProjectIds: [ids[2], ids[1]] }));
 });
  it("uses typed navigation and records an unmodified project selection", async () => {
   const user = userEvent.setup();
   const view = renderShell();
   await user.click(screen.getByRole("link", { name: "Open Gamma" }));
   expect(view.props.navigateToProject).toHaveBeenCalledWith(ids[2]);
   await waitFor(() => expect(view.platform.preferences.save).toHaveBeenCalledWith(expect.objectContaining({
     pinnedProjectIds: [ids[0]], recentProjectIds: [ids[2], ids[1]]
   })));
 });
  it("returns focus to the rail command trigger that opened the palette", async () => {
   const user = userEvent.setup();
   renderShell();
   const trigger = screen.getByRole("button", { name: "Open command palette" });
   await user.click(trigger);
   expect(screen.getByPlaceholderText("Search commands…")).toBeInTheDocument();
   await user.keyboard("{Escape}");
   expect(trigger).toHaveFocus();
 });
  it("collapses desktop navigation into 44px sheet controls on narrow screens", async () => {
   const user = userEvent.setup();
   renderShell();
   const shell = screen.getByRole("main").parentElement?.parentElement;
   expect(shell).toHaveClass("grid-cols-[minmax(0,1fr)]");
   expect(screen.getByRole("complementary", { name: "Projects" })).toHaveClass("hidden", "md:flex");
   expect(screen.getByRole("complementary", { name: "Project navigation" })).toHaveClass("hidden", "md:block");
   const navigation = screen.getByRole("button", { name: "Open navigation" });
   expect(navigation).toHaveClass("size-11");
   expect(screen.getByRole("button", { name: /Command/ })).toHaveClass("h-11");
   await user.click(navigation);
   expect(screen.getByRole("dialog", { name: "Workspace navigation" })).toBeInTheDocument();
   expect(screen.getByRole("button", { name: "Close" })).toHaveClass("size-11");
   expect(screen.getByRole("button", { name: "Open command palette" })).toHaveClass("size-11");
   expect(screen.getByRole("button", { name: "Overview" })).toHaveClass("h-11");
 });
  it("closes the mobile sheet before restoring focus after a failed palette command", async () => {
   const user = userEvent.setup();
   const signOut = vi.fn(() => Promise.reject(new Error("Sign out failed")));
   renderShell({ signOut });
   await user.click(screen.getByRole("button", { name: "Open navigation" }));
   const sheet = screen.getByRole("dialog", { name: "Workspace navigation" });
   await user.click(within(sheet).getByRole("button", { name: "Open command palette" }));
   await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace navigation" })).not.toBeInTheDocument());
   await user.click(screen.getByText("Sign out"));
   await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command Palette" })).not.toBeInTheDocument());
   expect(signOut).toHaveBeenCalledOnce();
   expect(screen.getByRole("button", { name: /Command/ })).toHaveFocus();
 });
  it("gives mobile project option menu items a 44px touch target", async () => {
   const user = userEvent.setup();
   renderShell();
   await user.click(screen.getByRole("button", { name: "Open navigation" }));
   const sheet = screen.getByRole("dialog", { name: "Workspace navigation" });
   await user.click(within(sheet).getByRole("button", { name: "Project options for Alpha Project" }));
   expect(screen.getByRole("menuitem", { name: "Unpin project" })).toHaveClass("h-11");
 });
  it("opens a compact retry warning for partial catalog failures", () => {
   renderShell({ catalog: { ...catalog, failures: [{ scope: "projects", parentId: "x", message: "Nope" }] }, retryCatalog: vi.fn() });
   expect(screen.getByRole("status")).toHaveTextContent("Some projects could not be loaded.");
   expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
 });
});
