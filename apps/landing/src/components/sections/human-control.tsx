import { Activity, KeyRound, ListChecks, ShieldOff } from "lucide-react";
import { Eyebrow } from "@/components/landing/agents";

const controls = [
  {
    icon: Activity,
    title: "See every change",
    text: "Task changes, document revisions, messages, and agent sessions land in one activity trail."
  },
  {
    icon: ListChecks,
    title: "Decide what is done",
    text: "Change any task’s status, scope, or priority, including reopening work an agent marked done."
  },
  {
    icon: ShieldOff,
    title: "Revoke an agent",
    text: "Its credentials stop working, its sessions close, and its active claims are revoked."
  },
  {
    icon: KeyRound,
    title: "One identity per tool",
    text: "Setup gives each coding tool its own agent identity, with credentials stored in macOS Keychain."
  }
];

export function HumanControlSection() {
  return (
    <section
      id="control"
      aria-labelledby="control-heading"
      className="site-container section-space"
    >
      <div className="grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-20">
        <div>
          <Eyebrow>What if an agent goes off track?</Eyebrow>
          <h2 id="control-heading" className="section-title">
            You are still
            <br />
            <span className="text-muted-foreground">the one in charge.</span>
          </h2>
          <p className="section-copy mt-6 max-w-md">
            Orchestrat coordinates the work. It does not run your agents or
            decide for you. You can see what happened, change course, and cut
            off access at any point.
          </p>
        </div>
        <ul className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2">
          {controls.map(({ icon: Icon, title, text }) => (
            <li key={title} className="bg-background p-6 sm:p-8">
              <Icon
                size={20}
                className="text-primary-text"
                aria-hidden="true"
              />
              <h3 className="mt-6 text-lg font-medium tracking-tight">
                {title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {text}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
