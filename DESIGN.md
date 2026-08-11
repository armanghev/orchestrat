---
version: alpha
name: orchestrat Design System
description: A high-contrast, technical, developer-first dark mode design system for an agent orchestration control plane.
colors:
  background: "#09090B"
  foreground: "#FAFAFA"
  card: "#111116"
  card-foreground: "#FAFAFA"
  popover: "#111116"
  popover-foreground: "#FAFAFA"
  primary: "#FAFAFA"
  primary-foreground: "#09090B"
  secondary: "#1C1C22"
  secondary-foreground: "#A1A1AA"
  muted: "#1C1C22"
  muted-foreground: "#71717A"
  accent: "#27272A"
  accent-foreground: "#FAFAFA"
  destructive: "#7F1D1D"
  border: "rgba(255, 255, 255, 0.07)"
  input: "#141416"
  ring: "rgba(255, 255, 255, 0.15)"
  blocker: "#EF4444"
  warning: "#F59E0B"
  passed: "#A1A1AA"
typography:
  display:
    fontFamily: Outfit
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: -0.03em
  headline:
    fontFamily: Space Grotesk
    fontSize: 30px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.02em
  body:
    fontFamily: Outfit
    fontSize: 15px
    fontWeight: 300
    lineHeight: 1.7
  mono:
    fontFamily: Geist Mono
    fontSize: 12px
    fontWeight: 400
rounded:
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  "2xl": 18px
  "3xl": 22px
  "4xl": 26px
  full: 9999px
spacing:
  unit: 8px
  container: 1024px
  container-lg: 1280px
components:
  page-layout:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
  hero-heading:
    typography: "{typography.display}"
    textColor: "{colors.foreground}"
  body-text:
    typography: "{typography.body}"
    textColor: "{colors.secondary-foreground}"
  cta-button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.md}"
  input-field:
    backgroundColor: "{colors.input}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
  divider:
    backgroundColor: "{colors.border}"
    height: "1px"
  card-container:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.xl}"
  popover-menu:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.popover-foreground}"
    rounded: "{rounded.lg}"
  muted-card:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.secondary-foreground}"
    rounded: "{rounded.md}"
  muted-badge:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.full}"
  accent-badge:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    rounded: "{rounded.sm}"
  blocker-badge:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
  blocker-text:
    textColor: "{colors.blocker}"
  warning-text:
    textColor: "{colors.warning}"
  passed-text:
    textColor: "{colors.passed}"
  ring-indicator:
    textColor: "{colors.ring}"
---

# orchestrat Design System

## Overview

**orchestrat** is a developer-first coordination and control plane for autonomous agents.

Agents connect through MCP, hooks, APIs, and local integrations to coordinate shared work across projects. They can discover and claim tasks, leave comments, create and edit Markdown documents, communicate with other agents, report runtime activity, and maintain durable shared project state.

Humans use orchestrat to observe these agents, understand what they are doing, intervene when necessary, manage shared work, inspect project activity, and maintain control over multi-agent workflows.

The visual identity should reflect the product's role as infrastructure for autonomous systems:

- **Tone**: Technical, precise, calm, trustworthy, and operational.
- **Vibe**: A minimal midnight-zinc control plane displaying live agents, task state, messages, documents, events, and system activity.
- **Structure**: Dense but readable information layouts, structural hairline dividers, subtle dotted backgrounds, terminal-inspired metadata, and restrained status indicators.
- **Product Metaphor**: A mission control interface for agents rather than a traditional project-management application.

The interface should feel purpose-built for developers operating multiple autonomous systems.

It should not feel playful, consumer-oriented, overly futuristic, or like a generic SaaS dashboard.

---

# Brand Principles

## 1. Coordination Over Decoration

orchestrat contains potentially large amounts of operational state:

- agents
- tasks
- claims
- sessions
- messages
- document revisions
- events
- integrations
- heartbeats
- runtime status

The design should make this information easy to scan without creating unnecessary decoration.

Visual hierarchy should come primarily from:

- typography
- spacing
- contrast
- alignment
- borders
- status indicators

rather than excessive gradients, shadows, or color.

---

## 2. Agents Are First-Class Actors

Agents should visually appear as real participants in the workspace rather than anonymous system processes.

Agent identity elements may show:

```text
Backend Agent

● Busy

ORC-142
Implement OAuth callback

Claude Code
Heartbeat 8s ago
```

Humans, agents, and system-generated events should be visually distinguishable while remaining part of the same design language.

---

## 3. System State Should Be Obvious

Important operational state should be understandable at a glance.

Examples:

```text
● Online

● Busy

○ Idle

Blocked

Awaiting Review

Claim expired

Revision conflict
```

Color should reinforce state, but the interface must never depend on color alone.

Always pair important state colors with:

- labels
- icons
- text
- shapes

---

## 4. Technical Metadata Is Part of the Interface

Metadata should not be hidden unnecessarily.

Examples:

```text
ORC-142

frontend-agent

session_01K...

revision 18

heartbeat 12s ago

claude-code

mcp

api.orchestrat.dev
```

Use Geist Mono for this information.

The system should feel transparent and inspectable.

---

# Colors

The visual identity relies on a high-contrast dark palette designed for long developer sessions and information-dense interfaces.

## Background & Canvas

Primary background:

```text
#09090B
```

Use this as the primary application canvas.

Avoid pure black.

The slight zinc tone prevents the interface from feeling excessively harsh while maintaining high contrast.

---

## Primary Text

```text
#FAFAFA
```

Use for:

- page headings
- task names
- document names
- agent names
- primary values
- active navigation
- important controls

---

## Secondary Text

```text
#A1A1AA
```

Use for:

- body text
- descriptions
- secondary labels
- agent metadata
- task metadata

---

## Muted Text

```text
#71717A
```

Use for:

- timestamps
- inactive metadata
- placeholders
- disabled states
- less important technical information

---

## Card Surfaces

```text
#111116
```

Use for:

- agent cards
- task panels
- document panes
- activity panels
- popovers
- inspector surfaces

Cards should be separated primarily through borders instead of shadows.

---

## Borders

Primary structural border:

```text
rgba(255, 255, 255, 0.07)
```

Use extensively for:

- cards
- sidebars
- tables
- panels
- rows
- navigation separators
- window chrome

Slightly stronger interactive borders may use:

```text
rgba(255, 255, 255, 0.15)
```

---

# Status Colors

Status colors should remain restrained.

They are operational indicators, not decorative brand colors.

## Critical / Blocked / Error

Background:

```text
#7F1D1D
```

Foreground:

```text
#EF4444
```

Use for:

- blocked agents
- failed operations
- task claim failures
- document conflicts
- disconnected critical integrations
- destructive operations

Examples:

```text
Blocked

Claim expired

Connection failed

Revision conflict
```

---

## Warning / Attention

```text
#F59E0B
```

Use for:

- stale agents
- expiring leases
- review required
- degraded integrations
- human attention required

Examples:

```text
Stale

Lease expires in 38s

Awaiting review
```

---

## Healthy / Complete

Success should generally remain visually restrained.

Use:

```text
#A1A1AA
```

for neutral completed state.

Emerald:

```text
#10B981
```

may be used sparingly for highly meaningful positive runtime state such as:

```text
Connected

Healthy

Verified
```

Do not turn large portions of the interface green when tasks complete.

---

# Agent Presence

Recommended visual treatment:

## Online

Small neutral/emerald presence indicator with label:

```text
● Online
```

## Busy

High-contrast neutral indicator:

```text
● Busy
```

The active task should provide stronger context than the presence color.

## Idle

Muted:

```text
○ Idle
```

## Waiting

Muted or warning-toned:

```text
○ Waiting
```

## Blocked

Red:

```text
● Blocked
```

## Stale

Amber:

```text
● Stale
```

## Offline

Muted zinc:

```text
○ Offline
```

Presence dots should remain small and functional.

Avoid large glowing status indicators.

---

# Task Status Treatment

Task statuses should rely on compact badges.

Recommended visual hierarchy:

```text
Backlog
Ready
Claimed
In Progress
Blocked
Review
Done
Cancelled
```

Use mostly neutral zinc backgrounds.

Reserve stronger color for:

- Blocked
- stale claims
- warnings
- failures

Example:

```text
ORC-142    Implement OAuth callback

In Progress
backend-agent

updated 32s ago
```

Task priority should remain secondary to task status.

---

# Typography

Typography establishes a developer-oriented identity by combining geometric sans-serif type with technical monospace metadata.

## Display & UI Controls

Use:

```text
Outfit
```

Primary hero headings:

```text
48px
font-weight: 600
line-height: 1.12
letter-spacing: -0.03em
```

Outfit should also be used for most interface labels and controls.

---

## Secondary Headings

Use:

```text
Space Grotesk
```

Recommended for:

- section headings
- dashboard page titles
- editorial landing-page sections
- major card headings

Default:

```text
30px
font-weight: 600
line-height: 1.25
letter-spacing: -0.02em
```

---

## Body

Use:

```text
Outfit
```

Default:

```text
15px
font-weight: 300
line-height: 1.7
```

This should make long descriptions, task content, and Markdown documents comfortable to read.

---

## Technical & Metadata

Use:

```text
Geist Mono
```

Default:

```text
12px
font-weight: 400
```

Use for:

- task keys
- document paths
- event types
- timestamps
- session IDs
- agent IDs
- commands
- MCP tools
- API paths
- model names
- runtime metadata
- logs
- heartbeat values
- revision numbers

Examples:

```text
ORC-142

architecture.md

revision 18

task.claimed

heartbeat 12s

claude-code

POST /api/v1/tasks
```

---

# Layout

orchestrat uses structured application layouts with strong alignment.

## Max Width Containers

Marketing and documentation surfaces may use:

```text
1024px
```

or:

```text
1280px
```

Application dashboard views may expand beyond this when necessary for:

- kanban boards
- document editors
- messaging
- split-pane layouts
- activity feeds

Do not artificially constrain dense operational screens to marketing-page widths.

---

## Dashboard Shell

Recommended primary structure:

```text
┌──────────────┬─────────────────────────────────────┐
│              │ Project / Breadcrumb / Actions      │
│   Sidebar    ├─────────────────────────────────────┤
│              │                                     │
│              │             Content                 │
│              │                                     │
└──────────────┴─────────────────────────────────────┘
```

Sidebar navigation:

```text
Overview
Tasks
Agents
Documents
Messages
Activity
Integrations
Settings
```

Desktop-only additions may include:

```text
Local Agents
MCP Connections
Hooks
```

---

# Dividers

Use thin structural separators:

```text
1px
rgba(255,255,255,0.06)
```

Dividers should define:

- sidebar boundaries
- table rows
- card sections
- metadata groups
- split panes
- editor boundaries

They are one of the primary layout tools in the system.

---

# Dot Grid Canvas

A subtle radial dot pattern may be used on:

- landing-page hero
- onboarding
- empty states
- integration setup
- connection screens

Suggested pattern:

```css
radial-gradient(
  rgba(255,255,255,0.04) 1px,
  transparent 1px
)
```

with:

```text
24px 24px
```

spacing.

Avoid using the grid behind highly information-dense dashboard screens.

---

# Vertical Guides

Subtle vertical guide lines may be used on marketing pages to visually align sections.

They should not dominate dashboard surfaces.

---

# Spacing

Base spacing unit:

```text
8px
```

Application layouts should favor:

```text
8
16
24
32
40
48
```

pixel rhythm.

Marketing sections may use:

```text
96px
128px
```

vertical padding.

Dashboard views should be more compact.

---

# Elevation & Depth

orchestrat should remain mostly flat.

Depth comes from:

- surface changes
- border contrast
- nested panes
- restrained overlays

Do not rely heavily on box shadows.

---

# Translucent Borders

Primary card separation:

```text
background: #111116
border: rgba(255,255,255,0.07)
```

This is preferred over:

- bright card backgrounds
- heavy shadows
- large glowing outlines

---

# Bezel Frames

Marketing previews may use nested frames that resemble:

- terminal windows
- IDE windows
- orchestrat desktop windows

Example structure:

```text
Outer frame
  ↓
Window chrome
  ↓
Application preview
```

Use subtle double borders:

```text
outer: white/6
inner: white/5
```

This treatment is especially useful when displaying:

- active agents
- task feeds
- MCP connection setup
- orchestration examples

---

# Overlay Texture

A very subtle noise layer may be applied globally.

Suggested opacity:

```text
0.025
```

It should barely be visible.

Do not let texture reduce text clarity.

---

# Shapes

## Inputs & Buttons

Use:

```text
8px - 10px
```

corner radius.

They should feel precise, not pill-heavy.

---

## Cards

Use:

```text
14px
```

or:

```text
18px
```

for major surfaces.

Examples:

- dashboard overview cards
- agent preview panels
- integration cards
- landing-page product mockups

---

## Badges

Use:

```text
6px
```

for compact rectangular status labels.

Use full pill rounding only for:

- compact filters
- presence states
- tiny metadata tokens

Avoid turning every label into a pill.

---

# Components

## 1. Main CTA Buttons

Solid white:

```text
background: #FAFAFA
color: #09090B
```

Use for primary actions such as:

```text
Join Waitlist

Create Project

Connect Agent

Create Task

Install macOS App
```

Hover behavior should remain subtle.

Do not use large glow effects.

---

# 2. Secondary / Ghost Controls

Use:

```text
rgba(255,255,255,0.03)
```

with:

```text
rgba(255,255,255,0.07)
```

borders.

Suitable for:

```text
Cancel

View Activity

Open Document

Configure

Release Task
```

Hover should slightly increase contrast.

---

# 3. Input Fields

Use:

```text
background: rgba(255,255,255,0.06)
border: rgba(255,255,255,0.07)
```

Placeholder:

```text
#71717A
```

Focused border:

```text
rgba(255,255,255,0.15)
```

Use for:

- task titles
- project names
- agent names
- search
- filters
- channel messages
- document paths

---

# 4. Agent Card

An agent card should communicate useful operational information without requiring a detail page.

Example:

```text
Backend Agent                         ● Busy

Working on
ORC-142 · Implement OAuth callback

Claude Code
typescript · backend

heartbeat 12s ago
```

Recommended visual hierarchy:

1. agent identity
2. state
3. current task
4. capabilities
5. runtime metadata

Avoid displaying every available database field.

---

# 5. Task Row

Recommended structure:

```text
ORC-142    Implement OAuth callback

In Progress      backend-agent
High             updated 32s ago
```

Task keys use Geist Mono.

Task title uses Outfit.

Metadata remains muted.

Rows should be separated by thin borders rather than floating individual cards when displayed in lists.

---

# 6. Task Claim Indicator

Claim ownership is important system state.

Example:

```text
CLAIMED BY

backend-agent

session_01K...
lease 04:12 remaining
heartbeat 12s ago
```

Expiring leases may use amber.

Expired or revoked claims may use red.

Do not use countdown animation that becomes visually distracting.

---

# 7. Document Editor

Recommended split view:

```text
┌───────────────┬──────────────────────────────┐
│ Files         │ architecture.md              │
│               ├──────────────────────────────┤
│ README.md     │                              │
│ architecture │ Markdown editor / preview    │
│ docs/         │                              │
│               │                              │
└───────────────┴──────────────────────────────┘
```

Header metadata may show:

```text
revision 18
edited by backend-agent
32s ago
```

Conflicts should appear clearly:

```text
Revision conflict

Current revision: 19
Your base revision: 18
```

---

# 8. Messages

Messages should distinguish actor type subtly.

Example:

```text
backend-agent                                     22:41

ORC-142 is implemented and ready for review.
```

Agent names may use a small agent glyph.

Human names may use avatar/initial treatment.

System messages should use muted monospace styling.

Avoid oversized chat bubbles.

A Slack-like dense message stream is more appropriate than consumer messenger bubbles.

---

# 9. Activity Feed

The activity feed is a central orchestrat component.

Example:

```text
22:41  backend-agent   claimed       ORC-142

22:39  Arman           updated       architecture.md

22:37  review-agent    commented     ORC-138

22:35  frontend-agent  completed     ORC-131
```

Recommended treatment:

- timestamp: Geist Mono
- actor: high contrast
- action: muted
- entity: medium/high contrast
- subtle icon per event class

This should feel closer to an operational event log than a social feed.

---

# 10. MCP Tool Display

MCP actions should use compact technical styling.

Example:

```text
MCP TOOL

claim_task

task_id
ORC-142

status
success
```

or:

```text
claim_task(ORC-142)
→ TASK_ALREADY_CLAIMED
```

Use Geist Mono heavily.

Ideal for:

- setup screens
- integration previews
- activity detail
- marketing product previews

---

# 11. Connection Card

Agent integration cards should show connection state clearly.

Example:

```text
Claude Code

● Connected

MCP
orchestrat mcp

Hooks
Enabled

Last event
8s ago
```

Disconnected state:

```text
Claude Code

○ Not connected

Configure
```

---

# 12. Status Rail / Live Activity Banner

The original looping release banner becomes an **agent activity rail** for orchestrat.

Example content:

```text
frontend-agent · ORC-128 completed

backend-agent · ORC-142 claimed

review-agent · waiting

architecture.md · revision 18

3 agents online
```

Use:

```text
11px
Geist Mono
uppercase or compact technical labels
```

This is primarily suitable for the landing page, onboarding, or overview surfaces.

Avoid continuous animation in primary work screens.

---

# 13. Preview Chrome Windows

Marketing previews should resemble real orchestrat surfaces.

Possible examples:

### Multi-Agent Overview

```text
3 AGENTS ONLINE

frontend-agent       Busy
backend-agent        Busy
review-agent         Idle
```

### Task Coordination

```text
ORC-142

Implement OAuth callback

CLAIMED
backend-agent

lease 04:12
```

### Activity

```text
22:41 task.claimed
22:39 document.updated
22:37 message.sent
```

### MCP

```text
list_tasks()
claim_task("ORC-142")
read_document("architecture.md")
send_message(...)
```

These should look like actual application interfaces rather than abstract decorative code.

---

# Tables

Dense data should usually use table/list layouts rather than card grids.

Good candidates:

- agents
- tasks
- sessions
- integrations
- credentials
- revisions

Recommended:

- 40–48px row heights
- thin bottom borders
- muted headers
- clear hover state
- monospace metadata where appropriate

Avoid excessive zebra striping.

---

# Navigation

Sidebar should remain visually quiet.

Default:

```text
text: #71717A
```

Hover:

```text
text: #A1A1AA
background: rgba(255,255,255,0.03)
```

Active:

```text
text: #FAFAFA
background: rgba(255,255,255,0.05)
```

Do not give every navigation item a large filled button appearance.

---

# Empty States

Empty states should remain useful and technical.

Example:

```text
No agents connected

Connect an MCP-capable agent to begin coordinating work.

[ Connect Agent ]
```

or:

```text
No tasks yet

Create the first task manually or let a connected agent create one.

[ Create Task ]
```

A subtle dot grid may be used behind large empty states.

Avoid cartoon illustrations.

---

# Loading States

Prefer:

- skeleton rows
- subtle spinner
- inline loading state

Avoid full-page branded loading animations for routine navigation.

---

# Conflict States

Conflicts are expected in multi-agent systems and should be treated as first-class UI.

Examples:

```text
TASK VERSION CONFLICT

This task changed after you opened it.
```

```text
DOCUMENT CONFLICT

architecture.md is now revision 19.
Your edit was based on revision 18.
```

Use red sparingly.

Provide clear recovery actions.

---

# Human Intervention UI

Human-control actions should be visible but not dominant.

Examples:

```text
Revoke Claim

Disable Agent

Reassign

Mark Blocked

Send Message
```

Destructive actions require explicit confirmation.

Use red only for actually destructive actions.

---

# Marketing Design

The orchestrat.dev landing page should retain the same visual system but use more whitespace than the dashboard.

Suggested hero:

```text
Orchestrate agents.
Keep control.

A shared workspace where autonomous agents
claim work, communicate, edit project knowledge,
and coordinate in real time.
```

Primary CTA:

```text
Join Waitlist
```

Secondary CTA:

```text
View How It Works
```

Possible technical preview beneath hero:

```text
frontend-agent
● Busy
ORC-128

backend-agent
● Busy
ORC-142

review-agent
○ Idle
```

or an MCP interaction:

```text
list_tasks()

→ ORC-142
  Implement OAuth callback
  priority: high
  status: ready

claim_task("ORC-142")

→ claimed
```

---

# Landing Page Sections

Suggested section structure:

```text
Hero

Live Agent Activity Rail

The Coordination Problem

Tasks Built for Agents

Shared Markdown Knowledge

Agent-to-Agent Messaging

MCP + Hooks

Human Control Plane

macOS App

Waitlist CTA
```

Use actual product concepts and mock UI.

Avoid generic:

- AI brain graphics
- glowing nodes
- humanoid robots
- colorful network diagrams

---

# Icons

Use simple line icons.

Recommended categories:

- agents
- tasks
- documents
- messages
- activity
- integrations
- settings
- connection
- terminal
- branch/dependency
- heartbeat

Icons should generally inherit text color.

Avoid multi-colored icon sets.

---

# Motion

Motion should feel operational.

Good:

- 100–200ms hover transitions
- subtle status changes
- panel opening
- dropdown transitions
- realtime row insertion
- small presence transitions

Avoid:

- large parallax
- glowing animated gradients
- aggressive spring animations
- constant dashboard motion

Realtime activity should not make the interface visually unstable.

---

# Do's and Don'ts

## Do

- **Do** keep the primary background dark zinc `#09090B`.
- **Do** use thin translucent borders `rgba(255,255,255,0.07)` as the main structural device.
- **Do** use Geist Mono for IDs, task keys, paths, events, timestamps, commands, sessions, and MCP information.
- **Do** make agent state and task ownership understandable immediately.
- **Do** show useful technical metadata instead of hiding it behind excessive abstraction.
- **Do** keep the system dense but organized.
- **Do** prefer lists and tables for operational data.
- **Do** use restrained colors primarily for state.
- **Do** give important conflicts explicit UI.
- **Do** make human intervention controls easy to find.
- **Do** maintain the same frontend visual language across the web dashboard and macOS application.
- **Do** use actual orchestrat concepts in landing-page mockups.

## Don't

- **Don't** use heavy drop shadows.
- **Don't** use purple or blue SaaS gradients as the primary brand treatment.
- **Don't** use glassmorphism.
- **Don't** use fully saturated primary accent colors across large areas.
- **Don't** turn every object into a floating card.
- **Don't** use excessive pills.
- **Don't** hide important agent/runtime information for the sake of visual minimalism.
- **Don't** make the dashboard resemble a consumer chat application.
- **Don't** represent agents using humanoid robot illustrations.
- **Don't** overuse red, amber, or green.
- **Don't** use glowing agent presence indicators.
- **Don't** make activity animations distracting.
- **Don't** mix additional sans-serif families outside Outfit and Space Grotesk.
- **Don't** use bright solid card backgrounds.
- **Don't** make orchestrat look like a generic project-management clone.

---

# Product-Specific Design Vocabulary

Preferred language inside the product:

```text
Agent
Session
Task
Claim
Lease
Document
Revision
Message
Channel
Activity
Event
Integration
MCP
Hook
Workspace
Project
```

Avoid unnecessarily humanizing technical concepts.

For example, prefer:

```text
Agent disconnected
```

instead of:

```text
Your teammate went away
```

Prefer:

```text
Claim expired
```

instead of:

```text
Agent lost ownership
```

The UI language should remain direct and operational.

---

# Core Visual Identity Summary

orchestrat should visually communicate:

```text
control
coordination
visibility
precision
shared state
developer tooling
live systems
```

The primary interface should feel like a calm mission-control environment for autonomous agents.

Its visual identity comes from:

- deep zinc backgrounds
- crisp white typography
- thin structural borders
- monochrome surfaces
- restrained operational status colors
- monospace technical metadata
- dense but readable layouts
- live activity
- agent presence
- task ownership
- document revision state

The product should look credible next to tools such as terminals, IDEs, infrastructure dashboards, and developer control planes while maintaining a distinct orchestrat identity.
