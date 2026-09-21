import { ContentPage, contentMetadata } from "@/components/content-page";

export const metadata = contentMetadata("guides");

export default function Page() {
  return <ContentPage slug="guides" />;
}
