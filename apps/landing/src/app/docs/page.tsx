import { ContentPage, contentMetadata } from "@/components/content-page";

export const metadata = contentMetadata("docs");

export default function Page() {
  return <ContentPage slug="docs" />;
}
