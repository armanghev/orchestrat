import { createFileRoute } from "@tanstack/react-router";

function SetupRoute() {
  return <main><h1>Setup</h1></main>;
}

export const Route = createFileRoute("/_authenticated/setup")({ component: SetupRoute });
