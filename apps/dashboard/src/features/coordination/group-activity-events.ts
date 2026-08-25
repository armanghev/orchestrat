import type { ProjectEvent } from "@orchestrat/protocol";

export type ActivityEventGroup = {
  event: ProjectEvent;
  events: ProjectEvent[];
};

const actorKey = (event: ProjectEvent) =>
  event.actor_agent_id
    ? `agent:${event.actor_agent_id}`
    : event.actor_user_id
      ? `user:${event.actor_user_id}`
      : "system";

const canJoin = (group: ActivityEventGroup, event: ProjectEvent) =>
  group.event.type === "document.updated" &&
  event.type === "document.updated" &&
  group.event.payload.save_kind === "autosave" &&
  event.payload.save_kind === "autosave" &&
  group.event.entity_id === event.entity_id &&
  actorKey(group.event) === actorKey(event);

export function groupActivityEvents(events: ProjectEvent[]) {
  return events.reduce<ActivityEventGroup[]>((groups, event) => {
    const current = groups.at(-1);
    if (current && canJoin(current, event)) current.events.push(event);
    else groups.push({ event, events: [event] });
    return groups;
  }, []);
}
