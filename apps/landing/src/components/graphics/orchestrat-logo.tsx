export function OrchestratLogo() {
  return (
    <span className="font-mono text-[13px] font-semibold tracking-[-0.03em] text-foreground">
      orchestrat<span className="font-normal text-muted-foreground">.dev</span>
    </span>
  );
}

export function OrchestratIcon({ className }: { className?: string }) {
  return <span className={className}>◌</span>;
}
