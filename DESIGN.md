---
version: alpha
name: Orchestrat Dashboard Design System
description: A calm, technical, desktop-first design system for an agent coordination workspace.
themes:
  default: system
  supported:
    - light
    - dark
    - system
colors:
  background: "var(--background)"
  foreground: "var(--foreground)"
  card: "var(--card)"
  card-foreground: "var(--card-foreground)"
  popover: "var(--popover)"
  popover-foreground: "var(--popover-foreground)"
  primary: "var(--primary)"
  primary-foreground: "var(--primary-foreground)"
  brand: "var(--brand)"
  primary-text: "var(--primary-text)"
  secondary: "var(--secondary)"
  secondary-foreground: "var(--secondary-foreground)"
  muted: "var(--muted)"
  muted-foreground: "var(--muted-foreground)"
  accent: "var(--accent)"
  accent-foreground: "var(--accent-foreground)"
  highlight: "var(--highlight)"
  highlight-foreground: "var(--highlight-foreground)"
  success: "var(--success)"
  success-foreground: "var(--success-foreground)"
  warning: "var(--warning)"
  warning-foreground: "var(--warning-foreground)"
  info: "var(--info)"
  info-foreground: "var(--info-foreground)"
  destructive: "var(--destructive)"
  destructive-foreground: "var(--destructive-foreground)"
  border: "var(--border)"
  input: "var(--input)"
  ring: "var(--ring)"
  rail: "var(--rail)"
  sidebar: "var(--sidebar)"
  sidebar-foreground: "var(--sidebar-foreground)"
  sidebar-accent: "var(--sidebar-accent)"
  sidebar-accent-foreground: "var(--sidebar-accent-foreground)"
  surface-raised: "var(--surface-raised)"
  overlay: "var(--overlay)"
palette:
  light:
    background: "oklch(1 0 0)"
    foreground: "oklch(0.205 0 0)"
    card: "oklch(1 0 0)"
    popover: "oklch(1 0 0)"
    primary: "oklch(0.205 0 0)"
    primary-foreground: "oklch(0.985 0 0)"
    brand: "oklch(0.7275 0.1669 53.99)"
    primary-text: "oklch(0.49 0.145 48)"
    secondary: "oklch(0.965 0 0)"
    muted: "oklch(0.965 0 0)"
    muted-foreground: "oklch(0.48 0 0)"
    accent: "oklch(0.95 0 0)"
    success: "oklch(0.43 0.1 155)"
    warning: "oklch(0.78 0.16 85)"
    info: "oklch(0.47 0.13 250)"
    destructive: "oklch(0.54 0.21 28)"
    border: "oklch(0.91 0 0)"
    input: "oklch(0.89 0 0)"
    ring: "oklch(0.6 0 0)"
    rail: "oklch(0.97 0 0)"
    sidebar: "oklch(0.98 0 0)"
    sidebar-accent: "oklch(0.935 0 0)"
  dark:
    background: "oklch(0.24 0 0)"
    foreground: "oklch(0.94 0 0)"
    card: "oklch(0.275 0 0)"
    popover: "oklch(0.29 0 0)"
    primary: "oklch(0.94 0 0)"
    primary-foreground: "oklch(0.205 0 0)"
    brand: "oklch(0.7275 0.1669 53.99)"
    primary-text: "oklch(0.78 0.14 57)"
    secondary: "oklch(0.32 0 0)"
    muted: "oklch(0.3 0 0)"
    muted-foreground: "oklch(0.71 0 0)"
    accent: "oklch(0.34 0 0)"
    success: "oklch(0.76 0.13 155)"
    warning: "oklch(0.8 0.15 85)"
    info: "oklch(0.75 0.1 250)"
    destructive: "oklch(0.71 0.16 28)"
    border: "oklch(0.36 0 0)"
    input: "oklch(0.39 0 0)"
    ring: "oklch(0.65 0 0)"
    rail: "oklch(0.22 0 0)"
    sidebar: "oklch(0.22 0 0)"
    sidebar-accent: "oklch(0.34 0 0)"
typography:
  page-title:
    fontFamily: system-ui
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.025em
  toolbar-title:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.25
  card-title:
    fontFamily: system-ui
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.375
  body:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  metadata:
    fontFamily: system-ui
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: SFMono-Regular
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: 8px
  md: 10px
  lg: 14px
  full: 9999px
spacing:
  unit: 4px
  rhythm: 8px
  page-compact: 16px
  page-default: 24px
  page-large: 32px
  container: 1280px
  sidebar: 256px
  sidebar-mobile: 288px
  toolbar-desktop: 48px
  toolbar-default: 56px
motion:
  shell-duration: 300ms
  shell-easing: "cubic-bezier(0.22, 1, 0.36, 1)"
  reduced-motion: remove-nonessential-transitions
components:
  page-layout:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    maxWidth: "{spacing.container}"
  toolbar-page-name:
    typography: "{typography.toolbar-title}"
    textColor: "{colors.primary-text}"
  body-text:
    typography: "{typography.body}"
    textColor: "{colors.foreground}"
  supporting-text:
    typography: "{typography.body}"
    textColor: "{colors.muted-foreground}"
  primary-button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
  secondary-button:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.md}"
  outline-button:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
  input-field:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    borderColor: "{colors.input}"
    rounded: "{rounded.md}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  card-container:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    outlineColor: "color-mix(in oklch, {colors.foreground} 10%, transparent)"
    rounded: "{rounded.lg}"
  popover-menu:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.popover-foreground}"
    rounded: "{rounded.md}"
  muted-region:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.md}"
  active-navigation:
    backgroundColor: "{colors.sidebar-accent}"
    textColor: "{colors.sidebar-accent-foreground}"
    rounded: "{rounded.sm}"
  status-success:
    backgroundColor: "color-mix(in oklch, {colors.success} 10%, transparent)"
    textColor: "{colors.success}"
    rounded: "{rounded.full}"
  status-warning:
    backgroundColor: "color-mix(in oklch, {colors.warning} 15%, transparent)"
    textColor: "{colors.warning-foreground}"
    rounded: "{rounded.full}"
  status-info:
    backgroundColor: "color-mix(in oklch, {colors.info} 10%, transparent)"
    textColor: "{colors.info}"
    rounded: "{rounded.full}"
  status-destructive:
    backgroundColor: "color-mix(in oklch, {colors.destructive} 10%, transparent)"
    textColor: "{colors.destructive}"
    rounded: "{rounded.full}"
  focus-ring:
    color: "{colors.ring}"
    width: 2px
---

# Orchestrat Dashboard Design

This document defines the visual and interaction system used by the Orchestrat dashboard. It describes the dashboard as it is implemented on the `codex/dashboard-redesign` branch and should guide future dashboard work.

The source code remains authoritative. When this document and the implementation disagree, update this document or the implementation deliberately rather than creating a third pattern.

## Product character

Orchestrat is a coordination workspace for people and autonomous agents. The dashboard should feel like a calm desktop work tool: structured, compact, operational, and easy to scan for long periods.

The design is built around these qualities:

- **Quiet structure.** Hierarchy comes from spacing, typography, alignment, and subtle separators.
- **Operational clarity.** Tasks, agents, documents, revisions, and system state should be understandable at a glance.
- **Desktop fluency.** The shell behaves like a native productivity app while remaining responsive on the web.
- **Restrained brand color.** Orange identifies selection, active context, and interactive emphasis. It does not fill page backgrounds or frame every surface.
- **Reusable primitives.** Use shadcn components and semantic design tokens before creating page-specific UI.
- **Information over decoration.** Avoid ornamental gradients, oversized marketing typography, glass effects, and heavy shadows.

## Foundations

### Typography

The dashboard uses the operating system UI font stack:

```css
-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif
```

Use the monospace stack for identifiers, slugs, task keys, paths, code, and technical metadata:

```css
"SFMono-Regular", "SF Mono", ui-monospace, monospace
```

The standard hierarchy is:

| Role | Treatment |
| --- | --- |
| Toolbar page name | `text-sm font-normal`, orange semantic text |
| Page or modal title | `text-2xl font-semibold tracking-tight` when a standalone heading is needed |
| Card title | `text-base font-medium leading-snug` |
| Body | `text-sm` |
| Supporting copy | `text-sm text-muted-foreground` |
| Metadata | `text-xs text-muted-foreground` |
| Technical identifier | `font-mono text-xs text-muted-foreground` |
| Metric | `text-3xl font-semibold tracking-tight` |

Keep headings sentence case. Avoid uppercase labels except established acronyms. Numeric content uses tabular figures globally.

### Spacing and density

Tailwind's spacing scale is the layout system. Prefer increments of 4 px, with 8 px as the common rhythm.

- Page container: `max-w-7xl`, centered.
- Page padding: 16 px compact, 24 px small desktop, 32 px large desktop.
- Page section gap: 24 px.
- Card and board gap: 16–24 px.
- Compact control gap: 6–8 px.
- Default card internal spacing: 16 px.
- Small card internal spacing: 12 px.
- Sidebar width: 256 px desktop, 288 px mobile sheet.
- Top toolbar height: 48 px in desktop mode, 56 px elsewhere.

Dense screens may show more information, but controls should retain comfortable hit targets and visible focus states.

### Shape and elevation

The root radius is 10 px. Controls generally use 8–10 px corners; cards and larger containers use 14 px corners.

Use a one-pixel semantic ring or border to separate surfaces. Shadows are reserved for overlays, popovers, and the selected tab treatment. Cards should not appear to float high above the page.

### Color system

All product UI uses the semantic variables in `apps/dashboard/src/globals.css`. Do not hardcode light or dark colors in components.

| Token | Purpose |
| --- | --- |
| `background` | Main canvas |
| `foreground` | Primary text and icons |
| `card` | Cards and raised work surfaces |
| `popover` | Menus, dialogs, and floating controls |
| `muted` | Recessed regions, quiet selection, skeletons |
| `muted-foreground` | Secondary text and metadata |
| `border` | Structural dividers and surface outlines |
| `input` | Input outlines and dark-mode control surfaces |
| `ring` | Keyboard focus |
| `sidebar` | Sidebar and desktop toolbar surface |
| `sidebar-accent` | Sidebar hover and selected background |
| `brand` | Orchestrat orange identity color |
| `primary-text` | Accessible orange text for active context and links |
| `success` | Online, active, completed |
| `warning` | Review, stale, caution |
| `info` | Claimed and in-progress state |
| `destructive` | Blocked, cancelled, destructive action, error |

Light mode uses a white canvas and very light neutral surfaces. Dark mode uses warm-neutral charcoal layers rather than pure black. The canvas, sidebar, cards, and popovers should remain visually distinguishable in both themes.

Use orange sparingly for:

- the active page name in the toolbar;
- active and hovered tab text;
- open organization and project selectors;
- active sidebar text;
- links and editor syntax accents;
- small identity marks or selected timeline nodes.

Do not use orange as a large page background, generic card border, or default status color.

Color never carries meaning alone. Status color must be paired with a label, icon, dot, or shape.

## Application shell

### Desktop frame

The desktop app uses a persistent 256 px sidebar and a 48 px top toolbar. The toolbar and sidebar share the `sidebar` surface so the shell reads as one continuous frame.

macOS traffic lights remain in the native titlebar area. The sidebar toggle and toolbar content align to the same horizontal divider. Drag regions must stay behind interactive controls, and double-clicking the toolbar may maximize the window.

The sidebar transition uses:

```text
300 ms cubic-bezier(0.22, 1, 0.36, 1)
```

Animate the sidebar width, toolbar padding, separator width, margin, and opacity together. Respect `prefers-reduced-motion` by removing nonessential transitions.

### Sidebar

The sidebar is project navigation, not a second settings panel.

Navigation is grouped as:

- **Workspace:** Overview, Tasks, Agents
- **Knowledge:** Documents, Activity
- **Administration:** Settings

Each destination uses a Lucide icon and a text label. The selected destination uses the neutral sidebar accent surface with orange text. Hover states remain subtle.

The lower sidebar hierarchy is fixed:

1. Search button with the `⌘K` shortcut.
2. Divider.
3. Profile dropdown with avatar, name, and email.

Profile settings and sign out belong in the profile menu. Search opens the global command menu.

On mobile, the sidebar becomes a 288 px sheet and closes after navigation.

### Top toolbar

The left side of the toolbar shows context as:

```text
Organization  ›  Project  ›  Branch  ›  Page
```

Organization, project and branch names are full-width content controls, not fixed-width truncation slots. They may truncate only when the window genuinely lacks space.

Clicking the organization name opens an organization switcher with:

- available organizations;
- New organization;
- Organization settings.

Clicking the project name opens projects from the selected organization with:

- available projects;
- New project;
- Project settings.

Clicking the branch name opens the project's branches with:

- the default branch first, then the most recently updated, up to 12 active branches;
- a dot plus "Unread messages" text on branches with unread messages, never the dot alone;
- **All branches…**, a searchable dialog with Active and Archived groups, when there are more branches or any archived ones;
- New branch, unless the project is archived;
- Branch settings.

The branch selector copies the organization and project selectors exactly: muted text that turns orange only while hovered or open. Every project page shows the selected branch's work. The branch lives in the `?branch=` search parameter, and the default branch has none. An archived branch keeps its pages readable: the shell shows one archived notice and every write control is hidden, not disabled.

The current page name is plain orange text and is not a dropdown.

The right side is ordered as:

1. Route-specific actions such as **New task**.
2. Search button with the platform shortcut.
3. Appearance menu.

Page-specific actions belong in the toolbar rather than duplicated page headers. Do not reintroduce Overview's removed status badge or View tasks button.

## Core component language

### Buttons

- Default buttons are dark-on-light or light-on-dark primary actions.
- Outline buttons are the common neutral action.
- Ghost buttons are for compact toolbar, menu, and icon actions.
- Destructive buttons are reserved for destructive mutations.
- Button heights range from 24 px for extra-small controls to 36 px for large controls; the normal height is 32 px.
- Icon-only buttons require an accessible label.
- Disabled buttons reduce opacity and do not accept pointer events.
- Pressed non-menu buttons may move down by one pixel.

Prefer one primary action per local context. Put secondary or infrequent operations in a menu.

### Cards

Cards use `bg-card`, a 14 px radius, and a one-pixel low-contrast ring. They do not use prominent shadows.

Card anatomy is:

- header with title, description, and optional top-right action;
- content;
- optional footer separated by a border and muted fill.

Metric cards may use the existing very subtle vertical gradient from `card` to a card/muted mix. Do not apply this gradient to every card.

### Badges and status

Badges are compact pills with text at 12 px. `StatusBadge` pairs every status with a dot and readable label.

Use the existing mapping:

- success: online, active, done;
- warning: review, stale;
- info: claimed, in progress;
- destructive: blocked, cancelled;
- secondary: neutral or queued states.

Priority badges use destructive only for urgent priority. Other priorities stay neutral so they do not compete with workflow state.

### Tabs

Tabs use a quiet muted container. Active tabs use the page surface and orange semantic text; hover changes text to orange before selection. Keep tab labels short and pair icons with text when the view changes substantially, such as Board and List.

### Tables and lists

Tables are for comparison-heavy data. Board cards and lists are for scanning work items. Technical keys and timestamps should remain visually secondary.

Use sticky headers only when a table scrolls independently. Keep row actions discoverable without filling each row with buttons.

### Forms

Forms use shadcn fields, labels, inputs, textareas, selects, and validation messages. Categorical values must use a real select or menu rather than free text.

- Labels are explicit.
- Placeholder text does not replace labels.
- Save actions expose pending and failure states.
- Conflicts preserve the user's draft and explain the next choice.
- Archived projects and documents are visibly read-only.

### Dialogs, sheets, and menus

- Dialogs are for focused creation, confirmation, comparison, and revision history.
- Right-side sheets are for task details and other work that benefits from keeping the underlying page visible.
- Dropdown menus are for selection and low-frequency actions.
- Destructive actions should be separated from routine actions.
- Overlays must trap focus and return focus to the invoking control.

## Page patterns

### Overview

The overview is a mission-control summary, not a report full of charts.

Its hierarchy is:

1. Four compact metric cards: online agents, active tasks, needs attention, completed tasks.
2. Work at a glance and tasks needing attention.
3. Current agent work and recent activity.

Use cards, progress, short tables, and focused empty states. Avoid adding page-title chrome above the metrics.

### Tasks

Tasks provide Board and List tabs.

The filter row contains:

- view tabs;
- task search;
- status select;
- result count.

Board columns use a recessed muted surface. Task cards use the standard card ring, a monospace task key, title, priority, and comment count. Empty columns say **No tasks** rather than displaying decorative art.

Task creation is a dialog. Task inspection and editing use a right-side sheet. **New task** lives in the top toolbar.

### Agents

Agents emphasize identity, presence, current work, and last heartbeat. Online and working states must pair semantic color with labels. Empty states should tell the user how to connect a runtime.

### Documents

Documents use a two-pane workspace:

- left: collapsible folder and document tree;
- right: selected document editor and actions.

Folders are closed by default. Files use Markdown-only creation, allow an untitled initial state, and support inline rename. New document and new folder actions belong beside the tree controls; folder rows can expose contextual creation.

The editor supports rich Markdown and source mode, including headings, links, lists, task lists, tables, code blocks, separators, and images. The rendered document typography is defined by `.document-markdown`.

Revision history is a date-grouped timeline:

- newest revisions appear first;
- a vertical connector links revision nodes;
- selected nodes use the theme accent;
- each entry shows revision number, time, and actor type;
- older pages append below the current timeline;
- the current revision is omitted from the selectable historical list;
- restore writes the selected content as a new revision, preserving history;
- restore is disabled while a local draft is unsaved or the document is read-only.

### Activity

Activity is chronological and metadata-forward. Filter out implementation noise that does not help a person understand project state. Event type, actor, affected entity, and time should be easy to scan.

### Settings

Organization and project settings are reached from their toolbar selectors. Profile settings are reached from the sidebar profile menu. Keep settings forms narrow enough to read and separate dangerous operations from routine configuration.

## Loading, empty, error, and conflict states

Every data surface must define all four states.

- **Loading:** use structural skeletons shaped like the eventual content.
- **Empty:** state what is missing and provide a relevant next action when one exists.
- **Error:** explain the failure in plain language and provide Retry when retrying is meaningful.
- **Conflict:** preserve local work, load the current server version, and let the user decide how to continue.

Connectivity problems appear in the shared shell banner. Do not repeat the same global connection warning in every card.

## Responsive behavior

The dashboard is desktop-first but must remain functional on smaller windows.

- Persistent sidebar becomes a sheet below the medium breakpoint.
- Organization, project and branch breadcrumb controls hide on compact widths; the page name remains. Search's **Branches** group switches branches there.
- Toolbar actions stay to the right and may reduce to icons when their meaning remains clear.
- Metric grids progress from one column to two and then four.
- Dense two-column page sections collapse to one column.
- Task board columns use two columns at medium widths and four at extra-large widths.
- Two-pane document layouts stack or provide independently scrollable regions.
- Avoid fixed widths that force horizontal page scrolling.

Test desktop layouts at the standard app window and narrow desktop widths. Test responsive behavior at 390 px and 320 px when a change touches shared layout.

## Motion

Motion explains spatial change. It should not decorate routine actions.

Use the shell's 300 ms easing for sidebar and toolbar geometry. Use short color and shadow transitions for hover and selection. Avoid animating large page regions on initial load.

All animation and transition effects must yield to `prefers-reduced-motion`.

## Accessibility

- Use semantic landmarks: navigation, header, main, section, aside, table, list.
- Every page or major region needs a meaningful accessible label.
- Keep a skip link to `#main-content`.
- Interactive icons require accessible names.
- Use `aria-current` for active navigation and `aria-pressed` for selectable revision nodes.
- Preserve visible focus rings in the shell, dialogs, document editor, and revision history.
- Do not place click handlers on noninteractive elements.
- Announce loading, save, error, and conflict status where appropriate.
- Maintain keyboard access for menus, tabs, sheets, dialogs, editor controls, and command search.
- Never rely on color alone for status or selection.

## Content style

Use concise, direct language.

- Buttons begin with verbs: **New task**, **Save now**, **Load older revisions**.
- Empty states describe the situation before suggesting an action.
- Errors explain what the user can do next.
- Prefer **Search** over **Command palette** in user-facing shell copy.
- Use **organization**, **project**, **branch**, **task**, **agent**, **document**, and **revision** consistently. "Branch" always means a project branch; revision history says "connector" for the line between revisions.
- Avoid implementation terms in the product interface unless they help a developer make a decision.

## Implementation rules

1. Reuse an existing component in `apps/dashboard/src/components/ui` before adding markup or a dependency.
2. Use Tailwind utilities for layout and component styling.
3. Use semantic color tokens; never hardcode theme-specific colors in route components.
4. Put shared behavior in the shell or shared component rather than duplicating it across routes.
5. Keep route-specific primary actions in `TopToolbarActions`.
6. Preserve the dashboard page container: `dashboard-page`.
7. Use Lucide icons at the component default size unless the context requires otherwise.
8. Keep realtime and mutation state visible without allowing it to rearrange the whole page.
9. Add a focused interaction test when introducing branching behavior, persistence, or conflict handling.
10. Verify both light and dark mode when changing tokens or shared surfaces.

## Avoid

- Pure black dashboard backgrounds.
- Orange page backgrounds or generic orange borders.
- Large logo blocks that compete with navigation.
- Repeated page headers below the toolbar.
- Heavy shadows on ordinary cards.
- Gratuitous gradients or glass effects.
- Fixed-width breadcrumb labels that truncate when space is available.
- Icon-only actions without accessible labels.
- Custom controls where a shadcn primitive already exists.
- Hiding operational state behind hover-only interactions.
- Replacing a user's unsaved draft during refetch or conflict recovery.

## Review checklist

Before considering a dashboard UI change complete, verify:

- It uses the established shell, page container, and shadcn primitives.
- Light and dark surfaces remain distinct without harsh contrast.
- Orange is limited to identity and active interaction cues.
- Toolbar, divider, sidebar toggle, breadcrumbs, route actions, search, and appearance controls align.
- Loading, empty, error, disabled, and archived states are accounted for.
- Keyboard focus is visible and interaction order is logical.
- The layout works with long organization, project, task, and document names.
- The layout does not overflow at supported compact widths.
- Dynamic state updates do not discard drafts or obscure conflicts.
- Focused tests, lint, typecheck, and the relevant build pass.

## Source map

The main implementation references are:

- `apps/dashboard/src/globals.css` — semantic tokens, page layout, Markdown typography, editor theming, reduced motion.
- `apps/dashboard/src/components/app-shell/app-shell.tsx` — shared shell, sidebar state, route actions, command search.
- `apps/dashboard/src/components/app-shell/context-sidebar.tsx` — navigation groups, search, profile menu.
- `apps/dashboard/src/components/app-shell/top-toolbar.tsx` — hierarchy selectors, route actions, search, appearance, desktop drag behavior.
- `apps/dashboard/src/components/ui` — shadcn-based primitives and variants.
- `apps/dashboard/src/features/overview/overview-page.tsx` — overview composition.
- `apps/dashboard/src/features/documents/markdown-editor.tsx` — Markdown authoring surface.
- `apps/dashboard/src/features/documents/document-history.tsx` — revision timeline, comparison, restore.
- `apps/dashboard/src/routes/_authenticated.projects.$projectId.tasks.tsx` — board/list and task-detail patterns.
- `apps/dashboard/src/routes/_authenticated.projects.$projectId.documents.tsx` — document tree and editor workspace.
