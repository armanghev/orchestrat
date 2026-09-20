import Link from "next/link";

export default function LegalLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <Link
        href="/"
        className="text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        &larr; Back to Orchestrat
      </Link>
      <div className="my-8 flex flex-wrap items-center justify-between gap-3 border-b pb-5 text-xs text-muted-foreground">
        <span className="text-primary-text">Legal</span>
        <span>
          Last updated <time dateTime="2026-09-19">September 19, 2026</time>
        </span>
      </div>
      <article className="space-y-8 text-sm leading-7 text-muted-foreground [&_a]:text-primary-text [&_a]:underline [&_a]:underline-offset-4 [&_h1]:text-3xl [&_h1]:leading-tight [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:text-foreground sm:[&_h1]:text-4xl [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:leading-snug [&_h2]:font-medium [&_h2]:text-foreground [&_li]:pl-1 [&_p+p]:mt-3 [&_strong]:font-medium [&_strong]:text-foreground [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
        {children}
      </article>
    </div>
  );
}
