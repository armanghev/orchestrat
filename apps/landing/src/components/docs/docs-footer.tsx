import { FooterCredits, FooterLegal } from "@/components/layout/footer";

/** Credits, license and legal links at the end of every docs page. */
export function DocsFooter() {
  return (
    <footer className="not-prose mt-10 flex flex-col gap-4 border-t pt-6">
      <FooterCredits />
      <FooterLegal />
    </footer>
  );
}
