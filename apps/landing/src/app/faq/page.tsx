import { ContentPage, contentMetadata } from "@/components/content-page";

export const metadata = contentMetadata("faq");

export default function Page() {
  return <ContentPage slug="faq" />;
}
