import { cn } from "@/lib/cn";

export function projectInitials(name: string): string {
  const initials = name
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || "P";
}

export function ProjectMark({
  name,
  active
}: {
  name: string;
  active?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 items-center justify-center rounded-lg text-xs font-semibold",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground"
      )}
    >
      {projectInitials(name)}
    </span>
  );
}
