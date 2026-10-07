import { useEffect, useRef, useState } from "react";
import {
  createOrganizationRequestSchema,
  createProjectRequestSchema
} from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DashboardApiError } from "@/lib/api/client";

export type CreationKind = "organization" | "project";
export type CreationInput = { name: string; description?: string | null };

// ponytail: the plain form the old /setup page used; the organization and
// project creation pages replace it with their own layouts (ORC-53, ORC-55).
export function CreationForm({
  kind,
  title,
  description,
  pending,
  onSubmit
}: {
  kind: CreationKind;
  title: string;
  description: string;
  pending: boolean;
  onSubmit(input: CreationInput): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const label = kind[0].toUpperCase() + kind.slice(1);

  useEffect(() => heading.current?.focus(), [kind]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const parsed =
      kind === "organization"
        ? createOrganizationRequestSchema.safeParse({ name })
        : createProjectRequestSchema.safeParse({
            name,
            description: projectDescription.trim() || null
          });
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Check the fields and try again."
      );
      return;
    }
    try {
      await onSubmit({
        name: parsed.data.name,
        ...(kind === "project"
          ? { description: projectDescription.trim() || null }
          : {})
      });
    } catch (cause) {
      setError(
        cause instanceof DashboardApiError
          ? cause.message
          : "Unable to create this item."
      );
    }
  }

  return (
    <section className="w-full max-w-md">
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight outline-none"
      >
        {title}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor={`${kind}-name`}>{label} name</Label>
          <Input
            id={`${kind}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
            autoComplete="off"
          />
        </div>
        {kind === "project" && (
          <div className="space-y-2">
            <Label htmlFor="project-description">Description (optional)</Label>
            <Textarea
              id="project-description"
              value={projectDescription}
              onChange={(event) => setProjectDescription(event.target.value)}
              disabled={pending}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? `Creating ${kind}...` : `Create ${kind}`}
        </Button>
      </form>
    </section>
  );
}
