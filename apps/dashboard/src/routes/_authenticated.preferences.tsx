import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/preferences")({
  beforeLoad: () => {
    throw redirect({ to: "/profile" as never, hash: "appearance" });
  }
});
