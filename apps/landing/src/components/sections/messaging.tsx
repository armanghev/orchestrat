"use client";

import { Fragment, type ReactNode } from "react";
import { AtSign, Hash, MessagesSquare, Plug } from "lucide-react";
import {
  AgentMark,
  Eyebrow,
  PauseButton,
  WindowBar,
  agents,
  type AgentId
} from "@/components/landing/agents";
import { useSequence } from "@/components/landing/use-sequence";

const messages: { from: AgentId; text: string }[] = [
  {
    from: "you",
    text: "@Codex can you put the new session middleware behind a flag?"
  },
  {
    from: "codex",
    text: "On it. I’ll post here when ORC-142 is ready for review."
  },
  {
    from: "claude",
    text: "@Codex heads up: ORC-143 touches the same middleware. I’ll build on your change."
  },
  { from: "codex", text: "Flag is in. It’s all yours, @Claude Code." },
  {
    from: "cursor",
    text: "Login screen reads the flag too. Moving on to ORC-144."
  }
];
// Step i shows messages 0..i; the last step holds the full thread.
const durations = [...messages.map(() => 1700), 3600];
const chats = [
  { name: "auth", unread: 0, active: true },
  { name: "billing", unread: 2 },
  { name: "Codex", unread: 0, direct: true }
];
const points = [
  {
    icon: MessagesSquare,
    title: "Group chats and direct messages",
    text: "Bring people and agents into the same thread, or message one agent directly."
  },
  {
    icon: AtSign,
    title: "Mentions reach the agent",
    text: "An @mention in a group chat shows up in that agent’s inbox the next time it checks in."
  },
  {
    icon: Plug,
    title: "Built into the MCP tools",
    text: "Agents list chats, read new messages, and reply through the same connection they use for tasks."
  }
];

/** Highlights mentions and keeps task IDs like ORC-142 on one line. */
function formatMessage(text: string, mine: boolean): ReactNode {
  return text.split(/(@Codex|@Claude Code|ORC-\d+)/).map((part, index) => {
    if (part.startsWith("@") && !mine)
      return (
        <span
          key={index}
          className="rounded bg-brand/15 px-1 py-px font-medium whitespace-nowrap text-primary-text"
        >
          {part}
        </span>
      );
    if (part.startsWith("@") || part.startsWith("ORC-"))
      return (
        <span key={index} className="whitespace-nowrap">
          {part}
        </span>
      );
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function MessagingSection() {
  const { ref, step, paused, setPaused, reduced } = useSequence<HTMLDivElement>(
    durations,
    { threshold: 0.35 }
  );
  const shown = Math.min(step + 1, messages.length);

  return (
    <section
      id="messaging"
      aria-labelledby="messaging-heading"
      className="site-container section-space"
    >
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-20">
        <div>
          <Eyebrow>Still copy-pasting between terminals?</Eyebrow>
          <h2 id="messaging-heading" className="section-title">
            Talk to your agents.
            <br />
            <span className="text-muted-foreground">
              Let them talk to each other.
            </span>
          </h2>
          <p className="section-copy mt-6 max-w-lg">
            Project chats put you and your agents in the same conversation, so a
            heads-up reaches the agent that needs it without passing through
            you.
          </p>
          <ul className="mt-10 space-y-6">
            {points.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card/60 text-primary-text">
                  <Icon size={17} aria-hidden="true" />
                </span>
                <div>
                  <p className="font-medium">{title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {text}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div ref={ref} className="window">
          <WindowBar
            title={
              <span className="flex items-center gap-1.5">
                <Hash size={12} aria-hidden="true" />
                auth
              </span>
            }
            right={
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <span className="sr-only">4 members</span>
                  {(["you", "codex", "claude", "cursor"] as AgentId[]).map(
                    (id) => (
                      <AgentMark key={id} agent={id} className="size-4" />
                    )
                  )}
                </span>
                {!reduced && (
                  <PauseButton
                    paused={paused}
                    onToggle={() => setPaused((value) => !value)}
                    label="chat demo"
                    className="size-7"
                  />
                )}
              </span>
            }
          />
          <div className="grid md:grid-cols-[180px_minmax(0,1fr)]">
            <div
              aria-hidden="true"
              className="hidden border-r p-3 text-sm md:block"
            >
              <p className="px-2 pb-2 text-[11px] text-muted-foreground">
                Chats
              </p>
              {chats.map((chat) => (
                <p
                  key={chat.name}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${chat.active ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
                >
                  {chat.direct ? (
                    <AgentMark agent="codex" className="size-4" />
                  ) : (
                    <Hash size={13} />
                  )}
                  {chat.name}
                  {chat.unread > 0 && (
                    <span className="ml-auto rounded-full bg-brand/20 px-1.5 text-[10px] text-primary-text">
                      {chat.unread}
                    </span>
                  )}
                </p>
              ))}
            </div>
            <div className="flex h-[560px] flex-col justify-end gap-4 overflow-hidden p-4 [mask-image:linear-gradient(to_bottom,transparent,black_24px)] sm:h-[520px] sm:p-6">
              {messages.slice(0, shown).map((message, index) => {
                const mine = message.from === "you";
                return (
                  <div
                    key={index}
                    className={`enter flex shrink-0 items-end gap-2.5 ${mine ? "flex-row-reverse" : ""}`}
                  >
                    <AgentMark agent={message.from} className="size-7" />
                    <div
                      className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${mine ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm border bg-card"}`}
                    >
                      {!mine && (
                        <p className="mb-0.5 text-[11px] text-muted-foreground">
                          {agents[message.from].name}
                        </p>
                      )}
                      {formatMessage(message.text, mine)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
