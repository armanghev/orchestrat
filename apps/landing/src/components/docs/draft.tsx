import { Callout } from "fumadocs-ui/components/callout";

/** Marks a page or section that depends on something not released yet. */
export function Draft() {
  return (
    <Callout type="warn">
      Draft: this describes v1, which isn’t released yet.
    </Callout>
  );
}
