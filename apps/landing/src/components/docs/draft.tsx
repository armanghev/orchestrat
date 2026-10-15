import { Callout } from "fumadocs-ui/components/callout";

/** Marks a page or section that describes v1 behavior that is not built yet. */
export function Draft() {
  return (
    <Callout type="warn">
      Draft: this describes v1, which is still being built.
    </Callout>
  );
}
