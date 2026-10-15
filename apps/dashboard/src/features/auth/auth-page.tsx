import {
  useCallback,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode
} from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export const authLinkClassName =
  "font-medium text-foreground underline underline-offset-4 hover:text-primary-text focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** The narrow, centered frame shared by sign-in, setup and sign-up. */
export function AuthPage({
  title,
  description,
  children,
  footer
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main
      id="main-content"
      className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12"
    >
      <section aria-labelledby="auth-heading" className="w-full max-w-sm">
        <p className="text-sm font-medium text-primary-text">Orchestrat</p>
        <h1
          id="auth-heading"
          className="mt-3 text-2xl font-semibold tracking-tight"
        >
          {title}
        </h1>
        {description ? (
          <div className="mt-2 text-sm text-muted-foreground">
            {description}
          </div>
        ) : null}
        {children ? <div className="mt-6">{children}</div> : null}
        {footer ? (
          <div className="mt-6 text-sm text-muted-foreground">{footer}</div>
        ) : null}
      </section>
    </main>
  );
}

export function AuthLoading({ label }: { label: string }) {
  return (
    <main
      id="main-content"
      className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12"
    >
      <div role="status" aria-label={label} className="w-full max-w-sm">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-4 h-7 w-48" />
        <Skeleton className="mt-8 h-8 w-full" />
        <Skeleton className="mt-4 h-8 w-full" />
        <Skeleton className="mt-6 h-8 w-full" />
      </div>
    </main>
  );
}

/** A labeled input with an optional hint; an error takes the hint's place. */
export function AuthField({
  id,
  label,
  error,
  hint,
  ...input
}: {
  id: string;
  label: string;
  error?: string | null;
  hint?: ReactNode;
} & Omit<ComponentProps<typeof Input>, "id">) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Focuses a field after the next render, once a pending form has enabled
 * its inputs again.
 */
export function useFieldFocus(): (id: string) => void {
  const [request, setRequest] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (request) document.getElementById(request.id)?.focus();
  }, [request]);
  return useCallback((id: string) => setRequest({ id }), []);
}
