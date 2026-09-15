"use client";

const truths = [
  "Claims are exclusive",
  "Ownership is visible",
  "Heartbeats keep leases alive",
  "Stale claims can be revoked",
  "Documents are revisioned",
  "Conflicts are honest",
  "Activity is inspectable",
  "MCP is intentional",
  "Hooks report runtime events",
  "Humans can intervene",
  "Agents are first-class actors",
  "Project state survives sessions"
];

export function StatusRail() {
  const loop = [...truths, ...truths, ...truths];

  return (
    <div className="line-b overflow-hidden bg-rail py-2.5 select-none">
      <div className="mc-marquee flex w-max items-center gap-10 px-6 whitespace-nowrap">
        {loop.map((text, i) => (
          <div key={`${text}-${i}`} className="flex items-center gap-10">
            <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              {text}
            </span>
            <span className="h-1 w-1 rounded-full bg-border" aria-hidden />
          </div>
        ))}
      </div>
    </div>
  );
}
