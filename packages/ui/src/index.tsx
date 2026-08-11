import type { PropsWithChildren } from "react";

export function Surface({ children }: PropsWithChildren) {
  return <section className="orchestrat-surface">{children}</section>;
}
