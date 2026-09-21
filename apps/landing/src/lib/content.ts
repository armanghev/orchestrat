export type ContentSection = {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  code?: string;
  links?: { label: string; href: string }[];
};

export type ContentPage = {
  slug: string;
  title: string;
  description: string;
  intro: string;
  sections: ContentSection[];
  related: string[];
  published?: string;
};

export const faqs: ContentSection[] = [
  {
    heading: "What is Orchestrat?",
    paragraphs: [
      "Orchestrat is a macOS workspace for coordinating AI coding agents. It brings shared tasks, task ownership, versioned Markdown documents, and live agent activity into one place, while you keep using your existing coding tools."
    ]
  },
  {
    heading: "Does Orchestrat run AI models or replace my coding tools?",
    paragraphs: [
      "No. Your coding tools run their own models and execute the work. Orchestrat gives connected agents shared project state through a local MCP bridge, lifecycle hooks, and an API. You remain responsible for reviewing changes and approving actions in your tools."
    ]
  },
  {
    heading: "Which coding agents can I connect?",
    paragraphs: [
      "The private-alpha setup supports Codex, Claude Code, Cursor, Antigravity, and OpenCode. Codex, Claude Code, Cursor, and Antigravity receive MCP and lifecycle-hook configuration; OpenCode uses MCP only. Pi can be detected, but cannot currently be selected for setup. Integration behavior depends on the installed tool version."
    ]
  },
  {
    heading: "Is Orchestrat available, and how much does it cost?",
    paragraphs: [
      "Orchestrat is in private early access. Join the waitlist to request an invitation. Public pricing has not been announced. Joining the waitlist does not create a paid subscription or guarantee access or a release date. Any future paid offering will show its price and terms before you agree to pay."
    ]
  },
  {
    heading: "Does it support Windows, Linux, or cloud agents?",
    paragraphs: [
      "The current private-alpha setup is for local coding agents on macOS. Windows, Linux, remote cloud agents, and CI agents are not currently supported by this setup."
    ]
  },
  {
    heading: "Is my project data stored only on my Mac?",
    paragraphs: [
      "No. Orchestrat uses a hosted service for shared project data and a local bridge for your coding tools. Integration credentials are stored in macOS Keychain. Tasks, comments, documents, attachments, and reported activity are handled by the hosted service. The Privacy Policy describes these data flows."
    ]
  },
  {
    heading: "Does a task claim prevent all conflicting code changes?",
    paragraphs: [
      "A task claim records exclusive ownership within Orchestrat. It is not a filesystem lock, Git branch, or guarantee that two agents cannot edit the same file. Give agents clear scopes and use separate branches or worktrees when their edits could overlap."
    ]
  },
  {
    heading: "Who builds Orchestrat, and how can I get in touch?",
    paragraphs: [
      "Orchestrat is built and maintained by @armanghev. For early access, product questions, support, or privacy requests, email arman@orchestrat.dev."
    ]
  }
];

export const contentPages: ContentPage[] = [
  {
    slug: "about",
    title: "About Orchestrat",
    description:
      "Meet Orchestrat, the macOS workspace for AI coding agents, built and maintained by @armanghev. Learn what it does and how to get in touch.",
    intro:
      "Orchestrat is a shared workspace for the work happening across your AI coding tools. Built and maintained by @armanghev, it connects tasks, project context, and agent activity in one macOS app.",
    sections: [
      {
        heading: "A shared place for the work",
        paragraphs: [
          "When several coding agents work on a project, their conversations do not automatically become a shared plan. An agent needs to know what it owns, which decisions are current, and what another agent has already changed. Orchestrat makes that project state available to both the developer and connected agents.",
          "Tasks record scope and ownership. Versioned Markdown documents hold plans and decisions. Activity shows meaningful changes across the project. Together, they give the next session somewhere to begin."
        ]
      },
      {
        heading: "Your tools, connected",
        paragraphs: [
          "Orchestrat works alongside coding tools through MCP, lifecycle hooks, and an API. The coding tools continue to run their models and execute changes. You choose which integrations to connect, review their work, and control their permissions.",
          "The private alpha focuses on one developer coordinating multiple local agents on macOS. It does not promise automatic assignment, built-in inference, or a complete record of every tool call."
        ]
      },
      {
        heading: "Creator and contact",
        paragraphs: [
          "@armanghev builds and maintains Orchestrat. For questions about the product, an early-access invitation, support, or privacy, contact arman@orchestrat.dev."
        ],
        links: [{ label: "Email support", href: "mailto:arman@orchestrat.dev" }]
      },
      {
        heading: "Current availability",
        paragraphs: [
          "Orchestrat is in private early access with a public waitlist. Features may change during the alpha. Public pricing and a general release date have not been announced."
        ],
        links: [
          { label: "Join the waitlist", href: "/#waitlist" },
          { label: "Privacy Policy", href: "/privacy" }
        ]
      }
    ],
    related: ["docs", "pricing", "faq"]
  },
  {
    slug: "docs",
    title: "Orchestrat documentation: connect your coding agents",
    description:
      "Set up Orchestrat on macOS, connect Codex and Claude Code through MCP, and understand shared tasks, documents, lifecycle hooks, and troubleshooting.",
    intro:
      "Orchestrat connects your local coding agents to a shared project through its CLI and MCP bridge. This guide covers the private-alpha setup for invited users on macOS.",
    sections: [
      {
        heading: "Before you begin",
        paragraphs: [
          "You need an Orchestrat account with access to a project, macOS, Node.js 20.19+ or a supported newer Node.js release, and at least one supported coding tool. Follow the installation details supplied with your invitation if they specify a particular alpha version.",
          "An npm package installation alone does not grant access to a project. If you have not been invited, join the waitlist first."
        ],
        links: [{ label: "Request early access", href: "/#waitlist" }]
      },
      {
        heading: "Install and connect",
        paragraphs: [
          "Install the alpha CLI, then run setup from the local project directory you want to connect. Setup detects installed coding tools, lets you choose integrations, and previews the configuration entries it will manage. Complete browser authorization and select the intended Orchestrat project when prompted.",
          "Setup creates a separate agent identity for each selected integration. Credentials go into macOS Keychain; the managed configuration connects the coding tool to the local bridge. Restart the tool’s MCP connection after setup so it loads the configuration."
        ],
        code: "npm install -g @orchestrat/cli@alpha\n# From your local project directory:\norchestrat setup\norchestrat status"
      },
      {
        heading: "How the MCP connection works",
        paragraphs: [
          "Setup manages the MCP launch command for your coding tool. The examples below show the bridge entry points for Codex and Claude Code; you normally let the coding tool launch them rather than run them as a separate daily workflow.",
          "A project-scoped connection is bound to its configured project. A global connection requires the agent to list and explicitly select an authorized project before doing project work."
        ],
        code: "orchestrat mcp --integration codex\norchestrat mcp --integration claude-code"
      },
      {
        heading: "Supported integrations",
        paragraphs: [
          "Codex, Claude Code, Cursor, and Antigravity support managed MCP and lifecycle-hook configuration. OpenCode supports managed MCP configuration only. Pi is detected but is not currently selectable for setup.",
          "MCP exposes intentional project actions such as reading tasks, claiming work, posting comments, and updating documents. Hooks report session start, session end, and failure. A session ending does not automatically complete a task."
        ]
      },
      {
        heading: "A first shared workflow",
        paragraphs: [
          "Create a small task with a clear outcome and put its constraints in a shared document. Ask one connected agent to read the project context, claim the task, do the work, and leave a comment explaining the result and checks performed.",
          "Use the macOS app to review task ownership, document revisions, and activity. Before handing the task to another agent, record what changed and what remains. Claims coordinate task ownership; use your coding tools and Git workflow to manage file edits and review code."
        ],
        bullets: [
          "Give each task one owner and a concrete completion condition.",
          "Keep enduring decisions in a shared document rather than only in a chat.",
          "Distinguish implemented changes, checks that passed, and work still awaiting review."
        ]
      },
      {
        heading: "Check or disconnect a connection",
        paragraphs: [
          "Run status to inspect configured connections and doctor to diagnose launcher, configuration, credential, and backend connectivity issues. Check that you are in the intended project directory. After a CLI update, restart the coding tool’s MCP connection.",
          "To remove an integration, use disconnect and inspect its preview. It revokes that integration’s agent credential and removes its managed entries. Do not paste access tokens into a document, agent prompt, or support message."
        ],
        code: "orchestrat status\norchestrat doctor\norchestrat disconnect codex",
        links: [
          { label: "Ask for setup help", href: "mailto:arman@orchestrat.dev" }
        ]
      }
    ],
    related: [
      "guides/mcp-agent-coordination",
      "guides/coordinate-multiple-coding-agents",
      "faq"
    ]
  },
  {
    slug: "pricing",
    title: "Orchestrat pricing and early access",
    description:
      "Orchestrat is in private early access. Public pricing is not yet announced. Learn what joining the waitlist means and how to request an invitation.",
    intro:
      "Orchestrat is in private early access. Public pricing has not been announced. Join the waitlist to request an invitation and hear about availability.",
    sections: [
      {
        heading: "What the waitlist means",
        paragraphs: [
          "Joining the waitlist registers your interest in Orchestrat. It does not create a paid subscription, reserve a price, or guarantee an invitation or release date. We use your email for early-access communications."
        ],
        links: [{ label: "Join the waitlist", href: "/#waitlist" }]
      },
      {
        heading: "What is available during the alpha?",
        paragraphs: [
          "The private alpha focuses on shared tasks, ownership, versioned documents, and agent activity for a developer using local coding agents on macOS. Setup connects supported tools through the CLI and MCP bridge. Features and availability may change as the product develops.",
          "Orchestrat does not provide the AI models used by connected coding tools. Your arrangements with those providers remain separate."
        ]
      },
      {
        heading: "Future plans and billing",
        paragraphs: [
          "Any future paid offering will disclose its pricing and payment terms before you agree to pay. We have not published subscription tiers, usage allowances, or a general-availability date. For product or access questions, contact arman@orchestrat.dev."
        ],
        links: [
          { label: "Contact support", href: "mailto:arman@orchestrat.dev" },
          { label: "Terms of Service", href: "/terms" }
        ]
      }
    ],
    related: ["about", "docs", "faq"]
  },
  {
    slug: "faq",
    title: "Orchestrat frequently asked questions",
    description:
      "Answers about Orchestrat, supported coding agents, macOS requirements, early access, pricing, project data, and task ownership.",
    intro:
      "Straight answers about what Orchestrat does, how agents connect, and what to expect during private early access.",
    sections: faqs,
    related: ["docs", "pricing", "about"]
  },
  {
    slug: "guides",
    title: "Guides to coordinating AI coding agents",
    description:
      "Practical guides to multi-agent coding workflows, MCP coordination, task ownership, and shared project context with Orchestrat.",
    intro:
      "Give each agent a clear job, keep the project’s decisions close to the work, and make the next handoff easier. Start with these practical guides.",
    sections: [],
    related: [
      "guides/coordinate-multiple-coding-agents",
      "guides/mcp-agent-coordination",
      "guides/shared-context-for-coding-agents"
    ]
  },
  {
    slug: "guides/coordinate-multiple-coding-agents",
    title: "How to coordinate multiple AI coding agents",
    description:
      "A practical workflow for giving AI coding agents clear scope, shared context, task ownership, and reviewable handoffs without losing track of the work.",
    intro:
      "Coordinate multiple coding agents by agreeing on the project context, splitting work into bounded tasks, assigning one owner to each task, and recording evidence before the next handoff. Orchestrat keeps those decisions and updates in a shared workspace.",
    published: "2026-09-20",
    sections: [
      {
        heading: "Start with one shared brief",
        paragraphs: [
          "Before opening another agent session, write down the outcome you want, the constraints that matter, and how you will know the work is complete. Include the relevant repository areas and any decisions that are already settled. A second agent cannot reliably follow a decision if it only exists in the first agent’s conversation.",
          "For an authentication change, the brief might specify the login methods, callback behavior, and expected session handling. Put that brief in a shared document and ask each agent to read it before selecting work. Update it when a decision changes so that new sessions do not begin from an obsolete plan."
        ]
      },
      {
        heading: "Split work at useful boundaries",
        paragraphs: [
          "A useful task has a clear output and enough independence to proceed without repeatedly changing another agent’s files. “Build authentication” may be too broad for parallel work. “Implement the callback handler against the agreed contract” and “Review the session-expiry flow” make the responsibilities easier to inspect.",
          "Write dependencies into the tasks. If the UI depends on an API shape, agree on that shape first. Parallel work helps when the boundaries are stable; opening more sessions does not make an unresolved interface decision disappear."
        ],
        bullets: [
          "State the intended change and affected area.",
          "List the decisions or tasks that must come first.",
          "Describe the observable completion condition.",
          "Identify which changes require human review."
        ]
      },
      {
        heading: "Claim ownership before editing",
        paragraphs: [
          "Have an agent read the task and claim it before starting. In Orchestrat, exclusive claims make ownership explicit and let other agents see which work is taken. If a session disappears, its lease can expire so another agent can take over.",
          "A claim is a coordination record, not a lock on source files. Two different tasks can still touch the same file. Use separate branches or worktrees when appropriate, communicate overlapping changes, and review the combined result. Do not treat an active claim as permission to make unrelated changes."
        ]
      },
      {
        heading: "Make progress visible and leave a handoff",
        paragraphs: [
          "Record meaningful changes as the work proceeds. A useful update says what changed, what was checked, and what remains uncertain. If an agent becomes blocked, name the decision or dependency it needs instead of leaving a task looking active indefinitely.",
          "For example: “Callback handling is implemented; the unit check passes; browser sign-in still needs verification.” That gives the next agent a concrete starting point. A generic “done” gives no way to distinguish an implementation from a tested or deployed result."
        ],
        code: "Changed: callback handler and session refresh\nChecked: unit check for expired-session behavior\nStill open: browser sign-in verification\nNext owner: review the callback flow before release"
      },
      {
        heading: "Review the combined result",
        paragraphs: [
          "When tasks meet again, inspect the actual code and run checks at the integration boundary. Two tasks passing their own checks does not prove the complete user flow works. Review the merged behavior, not only the status labels.",
          "Orchestrat provides shared tasks, documents, comments, and activity for this workflow. Your coding tools still execute the changes, and you decide whether the result is ready. Start with two agents and one bounded project so the coordination remains easy to understand."
        ],
        links: [{ label: "Connect your first agents", href: "/docs" }]
      }
    ],
    related: [
      "guides/shared-context-for-coding-agents",
      "guides/mcp-agent-coordination",
      "docs"
    ]
  },
  {
    slug: "guides/mcp-agent-coordination",
    title: "MCP for coding-agent coordination: tools, hooks, and shared state",
    description:
      "Understand how Orchestrat uses MCP for intentional project actions, lifecycle hooks for session signals, and a shared API for tasks and documents.",
    intro:
      "MCP gives a coding agent a way to call tools and read context outside its conversation. In Orchestrat, the local MCP bridge connects those actions to shared tasks, documents, and project activity. Hooks contribute lifecycle signals alongside that explicit work.",
    published: "2026-09-20",
    sections: [
      {
        heading: "What MCP contributes",
        paragraphs: [
          "The Model Context Protocol defines how an AI application connects to servers that expose tools and context. It supplies a common connection mechanism; the application and server still decide what actions mean and how they are authorized.",
          "For coordination, that distinction matters. Access to a task list is useful, but the shared service also needs to decide who can claim a task and how an update is recorded. Orchestrat supplies that project state behind the MCP tools."
        ],
        links: [
          {
            label: "MCP architecture reference",
            href: "https://modelcontextprotocol.io/docs/learn/architecture"
          }
        ]
      },
      {
        heading: "The local bridge connects an agent to a project",
        paragraphs: [
          "The Orchestrat CLI configures the coding tool to launch a local stdio MCP bridge. A configured integration has its own agent identity and credential, with credentials stored in macOS Keychain. Project-scoped setup binds the connection to the selected project.",
          "For Codex and Claude Code, the managed bridge commands look like the examples below. Run orchestrat setup to create the supported configuration. These commands explain what the coding tool launches; they are not a substitute for account authorization and project selection."
        ],
        code: "orchestrat mcp --integration codex\norchestrat mcp --integration claude-code"
      },
      {
        heading: "Use MCP for intentional changes",
        paragraphs: [
          "An agent can use the bridge to discover project work, read a task, claim it, post a comment, or update a shared document. These actions express a decision about the work. They should follow the same task scope and review expectations you give the agent in its coding environment.",
          "Suppose an agent implements an API change. It can read the agreed contract, claim the implementation task, record the result, and update the project document when the contract changes. The next agent can retrieve that shared context instead of depending on the previous conversation’s history."
        ]
      },
      {
        heading: "Use hooks for lifecycle signals",
        paragraphs: [
          "Hooks answer a different question: did a session start, end, or report failure? These signals help keep presence and activity connected to the tool’s lifecycle. They do not establish whether the code is correct or the task is complete.",
          "Orchestrat does not turn a session-end hook into a task-completion decision. An agent can stop because it finished, became blocked, or lost its connection. Keep completion explicit and attach the relevant evidence to the task. The activity feed records meaningful project events, not every keystroke or tool call."
        ]
      },
      {
        heading: "Keep connection health separate from task progress",
        paragraphs: [
          "If a connected agent cannot see a project or a tool, start with orchestrat status and orchestrat doctor. Confirm the intended project mapping and restart the coding tool’s MCP connection after configuration changes. Avoid putting credentials into prompts or manually sharing one agent’s credential with another.",
          "Once the connection works, review the task itself: ownership, prerequisites, shared documents, and the last meaningful update. A healthy connection does not tell you whether the work is ready. A completed task does not prove that a later session has the correct project selected."
        ],
        code: "orchestrat status\norchestrat doctor",
        links: [{ label: "Read the setup documentation", href: "/docs" }]
      }
    ],
    related: ["docs", "guides/coordinate-multiple-coding-agents", "faq"]
  },
  {
    slug: "guides/shared-context-for-coding-agents",
    title: "How to keep shared context across coding-agent sessions",
    description:
      "Use versioned project documents, task comments, and clear handoffs to keep AI coding agents working from current decisions across separate sessions.",
    intro:
      "Shared context is the project knowledge another agent needs to continue the work: the current goal, decisions, constraints, and evidence. Keep durable decisions in versioned documents and task-specific updates beside the task so a new session can find both.",
    published: "2026-09-20",
    sections: [
      {
        heading: "Separate project knowledge from a conversation",
        paragraphs: [
          "A chat is useful while you are solving a problem, but its history can mix proposals, rejected ideas, and current decisions. Copying the entire conversation into the next session asks the next agent to reconstruct which parts still apply.",
          "Write a short current-state document instead. Describe what the project is doing, the constraints it must respect, and the decisions that have actually been accepted. Keep supporting detail where it can be found, but make the starting point easy to read. The goal is to preserve the information needed for the next action."
        ]
      },
      {
        heading: "Give decisions a durable home",
        paragraphs: [
          "Use a shared Markdown document for information that affects several tasks: API contracts, architecture decisions, product requirements, or a release checklist. In Orchestrat, documents have revision history so the project can keep track of how that context changes.",
          "A useful decision includes the choice, the reason, and the boundaries. For example, record which component owns session refresh and why. Avoid leaving the same decision in several documents with slightly different wording; link to its main location from the relevant tasks."
        ],
        code: "Decision: the shared auth service owns session refresh.\nReason: desktop and browser flows need the same expiry behavior.\nApplies to: sign-in callbacks and authenticated requests.\nReview when: the session contract changes."
      },
      {
        heading: "Keep execution details with the task",
        paragraphs: [
          "Task comments are a better home for local progress: the files changed, a check that passed, a blocker, or a review request. They connect the update to its owner and outcome. A project document should not become a chronological dump of every small implementation step.",
          "At a handoff, record the current state, the evidence, and the next action. Be precise about what was verified. “Implemented locally” and “deployed and checked” describe different states, and the next agent should not need to guess which one you mean."
        ],
        bullets: [
          "What changed, and where?",
          "What was checked, and what was the result?",
          "What remains incomplete or uncertain?",
          "What should the next agent do first?"
        ]
      },
      {
        heading: "Read current state before writing",
        paragraphs: [
          "An agent resuming work should read the current task and relevant document revisions before making changes. Its earlier conversation may no longer reflect another agent’s edits or a human decision. If a document update conflicts, re-read the current version and reconcile the change rather than overwriting it blindly.",
          "Orchestrat keeps document revisions and protects updates against conflicts. That supports a shared record, but it does not decide which competing design is correct. Resolve the actual disagreement and write the accepted decision back into the document."
        ]
      },
      {
        heading: "Use activity to find the next question",
        paragraphs: [
          "The activity view helps you notice that a task changed hands, a document was updated, or a session ended. Follow those signals to the task or document for the details. Activity is a useful entry point, not a substitute for the underlying evidence.",
          "Keep a small set of maintained documents, link them from tasks, and ask agents to leave concise handoffs. Orchestrat makes that context available through the macOS workspace and local MCP bridge, while you review the decisions and the resulting work."
        ],
        links: [
          {
            label: "See how agent coordination works",
            href: "/guides/coordinate-multiple-coding-agents"
          }
        ]
      }
    ],
    related: ["guides/coordinate-multiple-coding-agents", "docs", "faq"]
  }
];
