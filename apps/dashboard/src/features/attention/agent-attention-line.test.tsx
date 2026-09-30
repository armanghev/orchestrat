import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiClient } from "@/lib/api/client";
import { agentAttention, project } from "@/test/factories";
import { AgentAttentionLine } from "./agent-attention-line";
import { agentAttentionQueryOptions, attentionKeys } from "./query-options";

describe("AgentAttentionLine", () => {
  it("pairs the status text with a tone", () => {
    const { container, rerender } = render(
      <AgentAttentionLine
        attention={agentAttention({
          current_task: {
            id: "00000000-0000-4000-8000-000000000041",
            key: "ORC-3",
            title: "Build",
            status: "in_progress"
          }
        })}
      />
    );
    expect(
      screen.getByText("Working on ORC-3 · in progress")
    ).toBeInTheDocument();
    const line = () =>
      container.querySelector('[data-slot="agent-attention-line"]');
    expect(line()).toHaveAttribute("data-tone", "working");
    rerender(
      <AgentAttentionLine
        attention={agentAttention({
          open_block: {
            task: {
              id: "00000000-0000-4000-8000-000000000042",
              key: "ORC-4",
              title: "API"
            },
            reason: "Waiting"
          }
        })}
      />
    );
    expect(screen.getByText("Blocked on ORC-4")).toBeInTheDocument();
    expect(line()).toHaveAttribute("data-tone", "blocked");
  });

  it("covers loading and unavailable states", () => {
    const { container, rerender } = render(
      <AgentAttentionLine attention={undefined} loading />
    );
    expect(
      container.querySelector('[data-slot="agent-attention-line"]')
    ).toHaveAttribute("aria-hidden", "true");
    rerender(<AgentAttentionLine attention={null} />);
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
  });

  it("polls every 30 seconds under the project attention key", () => {
    const api = new ApiClient("http://localhost:8801", {
      getAccessToken: async () => "test-token",
      expireSession: async () => undefined
    });
    const options = agentAttentionQueryOptions(api, project().id);
    expect(options.refetchInterval).toBe(30_000);
    expect(options.queryKey).toEqual(attentionKeys.agents(project().id));
    expect(options.queryKey.slice(0, 2)).toEqual(
      attentionKeys.project(project().id)
    );
  });
});
