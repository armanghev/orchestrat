import { Fragment, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Bell, BellOff, Bot, X } from "lucide-react";
import type {
  MessageCandidate,
  ParticipantRef,
  Task,
  TaskAttentionOverlay,
  TaskComment
} from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MarkdownContent } from "@/features/coordination/markdown-content";
import { messageCandidatesQueryOptions } from "@/features/messaging/query-options";
import type { ApiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import {
  attentionSummaryQueryOptions,
  invalidateAttentionQueries,
  taskAttentionQueryOptions
} from "./query-options";

const MAX_MENTIONS = 20;
const refKey = (participant: ParticipantRef) =>
  `${participant.type}:${participant.id}`;

const leaseMinutes = (leaseExpiresAt: string, now: number) =>
  Math.max(0, Math.ceil((Date.parse(leaseExpiresAt) - now) / 60_000));

/** "Claimed by claude-code · in progress · lease 4 min" (spec §14). */
export function TaskClaimLine({
  claim,
  status
}: {
  claim: NonNullable<TaskAttentionOverlay["claim"]>;
  status: Task["status"];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-info" />
      <span>
        Claimed by{" "}
        <span className="font-medium text-foreground">{claim.agent_name}</span>{" "}
        · {status.replaceAll("_", " ")} · lease{" "}
        {leaseMinutes(claim.lease_expires_at, now)} min
      </span>
    </p>
  );
}

type TaskAttentionPanelProps = {
  api: ApiClient;
  projectId: string;
  taskId: string;
  comments: TaskComment[];
  archived: boolean;
  commenting: boolean;
  onComment: (body: string, mentions: ParticipantRef[]) => Promise<unknown>;
};

/**
 * Task comments with the viewer's attention state: the watch toggle, a New
 * divider at the read position, a read call once the list is visible, and an
 * @mention composer backed by the chat candidate list.
 */
export function TaskAttentionPanel({
  api,
  projectId,
  taskId,
  comments,
  archived,
  commenting,
  onComment
}: TaskAttentionPanelProps) {
  const queryClient = useQueryClient();
  const overlays = useQuery(taskAttentionQueryOptions(api, projectId));
  const summary = useQuery(attentionSummaryQueryOptions(api, projectId));
  const overlay = overlays.data?.tasks.find((item) => item.task_id === taskId);
  const summaryItem = summary.data?.tasks.find(
    (item) => item.task_id === taskId
  );
  const watching = overlay?.watching ?? summaryItem?.watching ?? false;
  const attentionLoaded = overlays.isSuccess && summary.isSuccess;
  const latestSequence = comments.reduce(
    (latest, comment) => Math.max(latest, comment.sequence),
    0
  );
  const watch = useMutation({
    mutationFn: (next: boolean) => api.watchTask(taskId, next),
    onSettled: () => invalidateAttentionQueries(queryClient, projectId)
  });
  const markRead = useMutation({
    mutationFn: (through: number) => api.markTaskCommentsRead(taskId, through),
    onSettled: () => invalidateAttentionQueries(queryClient, projectId)
  });

  // The divider stays where the read position was when the comments first
  // rendered, so marking them read does not make it vanish under the reader.
  const [dividerAfter, setDividerAfter] = useState<number | null | undefined>(
    undefined
  );
  useEffect(() => {
    if (dividerAfter !== undefined || !attentionLoaded || !comments.length)
      return;
    const lastRead = summaryItem?.last_read_sequence;
    setDividerAfter(
      lastRead !== undefined && latestSequence > lastRead ? lastRead : null
    );
  }, [
    attentionLoaded,
    comments.length,
    dividerAfter,
    latestSequence,
    summaryItem?.last_read_sequence
  ]);

  const listRef = useRef<HTMLOListElement>(null);
  const [listVisible, setListVisible] = useState(false);
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const pageVisible = () =>
      typeof document === "undefined" || document.visibilityState === "visible";
    if (typeof IntersectionObserver === "undefined") {
      const update = () => setListVisible(pageVisible());
      update();
      document.addEventListener("visibilitychange", update);
      return () => document.removeEventListener("visibilitychange", update);
    }
    let intersecting = false;
    const update = () => setListVisible(intersecting && pageVisible());
    const observer = new IntersectionObserver((entries) => {
      intersecting = entries.some((entry) => entry.isIntersecting);
      update();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [comments.length]);

  // Only report reads when the server says something is unread, so opening an
  // unwatched task never creates read state as a side effect.
  const markedThroughRef = useRef(0);
  const hasUnread =
    (overlay?.unread_count ?? 0) > 0 ||
    (summaryItem !== undefined &&
      summaryItem.last_read_sequence < latestSequence);
  const { mutate: markThrough } = markRead;
  useEffect(() => {
    if (
      !listVisible ||
      !attentionLoaded ||
      !hasUnread ||
      latestSequence <= markedThroughRef.current
    )
      return;
    markedThroughRef.current = latestSequence;
    markThrough(latestSequence);
  }, [attentionLoaded, hasUnread, latestSequence, listVisible, markThrough]);

  const firstUnread =
    dividerAfter === undefined || dividerAfter === null
      ? undefined
      : comments.find((comment) => comment.sequence > dividerAfter)?.id;

  return (
    <section aria-labelledby="task-comments-heading" className="mt-5">
      <div className="flex items-center justify-between gap-2">
        <h3 id="task-comments-heading" className="text-sm font-semibold">
          Comments
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Watch task"
          aria-pressed={watching}
          disabled={!attentionLoaded || watch.isPending}
          className="text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
          onClick={() => watch.mutate(!watching)}
        >
          {watching ? (
            <Bell data-icon="inline-start" aria-hidden="true" />
          ) : (
            <BellOff data-icon="inline-start" aria-hidden="true" />
          )}
          Watch
        </Button>
      </div>
      {watch.isError ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Couldn’t update watching. Try again.
        </p>
      ) : null}
      <ol
        ref={listRef}
        aria-label="Task comments"
        className="mt-2 flex flex-col gap-2"
      >
        {comments.length ? (
          comments.map((item) => (
            <Fragment key={item.id}>
              {item.id === firstUnread ? (
                <li
                  data-slot="new-comments-divider"
                  className="flex items-center gap-2 text-xs font-medium text-primary-text"
                >
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                  New
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                </li>
              ) : null}
              <li className="rounded bg-muted/50 p-2 text-sm">
                <span className="font-medium">
                  {item.author.full_name}
                  {item.author.type === "agent" ? " (agent)" : ""}
                </span>
                <MarkdownContent content={item.body_markdown} empty="" />
                {item.mentions.length ? (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {item.mentions.map((mention) => (
                      <span
                        key={refKey(mention)}
                        className="rounded-full bg-highlight px-1.5 text-xs text-highlight-foreground"
                      >
                        @{mention.name}
                      </span>
                    ))}
                  </p>
                ) : null}
              </li>
            </Fragment>
          ))
        ) : (
          <li className="text-sm text-muted-foreground">No comments yet.</li>
        )}
      </ol>
      {!archived ? (
        <TaskCommentComposer
          api={api}
          projectId={projectId}
          disabled={commenting}
          commenting={commenting}
          onComment={onComment}
        />
      ) : null}
    </section>
  );
}

function TaskCommentComposer({
  api,
  projectId,
  disabled,
  commenting,
  onComment
}: {
  api: ApiClient;
  projectId: string;
  disabled: boolean;
  commenting: boolean;
  onComment: (body: string, mentions: ParticipantRef[]) => Promise<unknown>;
}) {
  const [comment, setComment] = useState("");
  const [mentions, setMentions] = useState<MessageCandidate[]>([]);
  const [picking, setPicking] = useState(false);
  const candidates = useQuery({
    ...messageCandidatesQueryOptions(api, projectId),
    enabled: picking
  });
  const available = (candidates.data?.candidates ?? []).filter(
    (candidate) => !mentions.some((item) => refKey(item) === refKey(candidate))
  );
  const addMention = (candidate: MessageCandidate) => {
    setComment(
      (current) =>
        `${current}${current && !current.endsWith(" ") ? " " : ""}@${candidate.name.replace(/\s+/gu, "_")} `
    );
    setMentions((current) =>
      current.length >= MAX_MENTIONS ? current : [...current, candidate]
    );
    setPicking(false);
  };
  return (
    <form
      className="mt-3"
      aria-label="New comment"
      onSubmit={(event) => {
        event.preventDefault();
        if (!comment.trim()) return;
        void onComment(
          comment.trim(),
          mentions.map(({ type, id }) => ({ type, id }))
        )
          .then(() => {
            setComment("");
            setMentions([]);
          })
          .catch(() => undefined);
      }}
    >
      {mentions.length ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {mentions.map((mention) => (
            <span
              key={refKey(mention)}
              className="inline-flex items-center gap-1 rounded-full bg-highlight px-2 py-0.5 text-xs font-medium text-highlight-foreground"
            >
              @{mention.name}
              <button
                type="button"
                className="rounded-full"
                aria-label={`Remove ${mention.name}`}
                onClick={() =>
                  setMentions((current) =>
                    current.filter((item) => refKey(item) !== refKey(mention))
                  )
                }
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <div className="relative">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            aria-label="Mention"
            aria-expanded={picking}
            disabled={disabled || mentions.length >= MAX_MENTIONS}
            onClick={() => setPicking((open) => !open)}
          >
            <AtSign aria-hidden="true" />
          </Button>
          {picking ? (
            <div className="absolute bottom-9 left-0 z-20 w-64 rounded-md bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10">
              <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                Mention someone
              </p>
              {candidates.isPending ? (
                <p role="status" className="px-2 py-1.5 text-sm">
                  Loading people and agents…
                </p>
              ) : candidates.isError ? (
                <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
                  <span>Couldn’t load people.</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => void candidates.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : available.length ? (
                <ul className="max-h-48 overflow-auto">
                  {available.map((candidate) => (
                    <li key={refKey(candidate)}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                        onClick={() => addMention(candidate)}
                      >
                        {candidate.type === "agent" ? (
                          <Bot
                            className="size-4 text-muted-foreground"
                            aria-hidden="true"
                          />
                        ) : (
                          <AtSign
                            className="size-4 text-muted-foreground"
                            aria-hidden="true"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {candidate.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {candidate.type === "agent" ? "Agent" : "Human"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  No one else to mention.
                </p>
              )}
            </div>
          ) : null}
        </div>
        <Input
          aria-label="Add comment"
          value={comment}
          disabled={disabled}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Add a Markdown comment"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={disabled || !comment.trim()}
          className={cn(commenting && "cursor-progress")}
        >
          {commenting ? "Commenting…" : "Comment"}
        </Button>
      </div>
    </form>
  );
}
