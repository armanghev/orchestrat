export function OrchestratIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={`size-8 shrink-0 text-brand ${className}`}
    >
      <circle
        cx="16"
        cy="16"
        r="12"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeDasharray="0.1 6.18"
      />
      <circle cx="16" cy="16" r="4" fill="currentColor" />
    </svg>
  );
}

export function OrchestratLogo() {
  return (
    <span className="inline-flex items-center gap-2.5 text-lg font-semibold tracking-tight">
      <OrchestratIcon />
      Orchestrat
    </span>
  );
}
