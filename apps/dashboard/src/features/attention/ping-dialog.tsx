import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import type {
  AttentionTaskRef,
  CreateHandoffRequest,
  MessageCandidate,
  ParticipantRef
} from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  messageCandidatesQueryOptions,
  messagingKeys
} from "@/features/messaging/query-options";
import type { ApiClient } from "@/lib/api/client";
import { useOptionalBranch } from "@/features/branches/branch-context";
import { handoffErrorMessage } from "./attention-copy";
import { invalidateAttentionQueries } from "./query-options";

const MAX_BODY = 4000;
const refKey = (participant: ParticipantRef) =>
  `${participant.type}:${participant.id}`;

type PingDialogProps = {
  api: ApiClient;
  projectId: string;
  /** Prefilled task reference, sent as the handoff's task_id. */
  task?: AttentionTaskRef | null;
  /** Preselected recipient when it is still a message candidate. */
  defaultRecipient?: ParticipantRef | null;
  disabled?: boolean;
  /** Accessible name for the trigger when several Ping buttons share a page. */
  triggerLabel?: string;
};

/**
 * Ping: a human handoff, i.e. a direct message plus a handoff row that wakes a
 * waiting agent. The trigger owns focus return, and a retry of the same draft
 * reuses its idempotency key.
 */
export function PingDialog({
  api,
  projectId,
  task = null,
  defaultRecipient = null,
  disabled = false,
  triggerLabel
}: PingDialogProps) {
  const formId = useId();
  const queryClient = useQueryClient();
  // The handoff's direct message lives on the branch on screen.
  const branchId = useOptionalBranch()?.branchId;
  const [open, setOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [body, setBody] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const candidates = useQuery({
    ...messageCandidatesQueryOptions(api, projectId),
    enabled: open
  });
  const list = candidates.data?.candidates ?? [];
  const selected = list.find((candidate) => refKey(candidate) === recipient);
  const send = useMutation({
    mutationFn: ({
      input,
      key
    }: {
      input: CreateHandoffRequest;
      key: string;
      name: string;
    }) => api.createHandoff(projectId, input, key, { branchId }),
    onSuccess: (_result, { name }) => {
      attempt.current = null;
      setBody("");
      setSentTo(name);
      setOpen(false);
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: messagingKeys.chats(projectId)
        }),
        queryClient.invalidateQueries({
          queryKey: messagingKeys.inbox(projectId)
        }),
        invalidateAttentionQueries(queryClient, projectId)
      ]);
    }
  });
  const pending = send.isPending;
  const agents = list.filter((candidate) => candidate.type === "agent");
  const people = list.filter((candidate) => candidate.type === "human");
  const option = (candidate: MessageCandidate) => (
    <NativeSelectOption key={refKey(candidate)} value={refKey(candidate)}>
      {candidate.name}
    </NativeSelectOption>
  );
  const submit = () => {
    const trimmed = body.trim();
    if (!selected || !trimmed || pending) return;
    const input: CreateHandoffRequest = {
      to: { type: selected.type, id: selected.id },
      body_markdown: trimmed,
      ...(task ? { task_id: task.id } : {})
    };
    // Same draft, same key: a retry after a lost response cannot send twice.
    const payload = JSON.stringify(input);
    if (attempt.current?.payload !== payload)
      attempt.current = { payload, key: crypto.randomUUID() };
    send.mutate({ input, key: attempt.current.key, name: selected.name });
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          if (next) {
            send.reset();
            setSentTo(null);
            if (!recipient && defaultRecipient)
              setRecipient(refKey(defaultRecipient));
          }
          setOpen(next);
        }}
      >
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={triggerLabel}
          >
            <BellRing data-icon="inline-start" aria-hidden="true" />
            Ping
          </Button>
        </DialogTrigger>
        <DialogContent
          className="sm:max-w-md"
          showCloseButton={!pending}
          onEscapeKeyDown={(event) => pending && event.preventDefault()}
          onPointerDownOutside={(event) => pending && event.preventDefault()}
          onOpenAutoFocus={(event) => {
            // With a recipient already chosen, the message is the next step.
            if (!defaultRecipient) return;
            event.preventDefault();
            messageRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Ping</DialogTitle>
            <DialogDescription>
              Send a direct message marked as a handoff. Agents waiting for
              updates wake up for it.
            </DialogDescription>
          </DialogHeader>
          <form
            id={formId}
            aria-label="Ping"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-recipient`}>
                  Recipient
                </FieldLabel>
                <NativeSelect
                  id={`${formId}-recipient`}
                  className="w-full"
                  required
                  value={selected ? recipient : ""}
                  aria-busy={candidates.isPending}
                  disabled={pending}
                  onChange={(event) => setRecipient(event.target.value)}
                >
                  <NativeSelectOption value="">
                    {candidates.isPending
                      ? "Loading people and agents…"
                      : "Choose a recipient"}
                  </NativeSelectOption>
                  {agents.length ? (
                    <NativeSelectOptGroup label="Agents">
                      {agents.map(option)}
                    </NativeSelectOptGroup>
                  ) : null}
                  {people.length ? (
                    <NativeSelectOptGroup label="People">
                      {people.map(option)}
                    </NativeSelectOptGroup>
                  ) : null}
                </NativeSelect>
                {candidates.isError ? (
                  <p
                    role="alert"
                    className="flex items-center gap-2 text-xs text-destructive"
                  >
                    Couldn’t load people and agents.
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => void candidates.refetch()}
                    >
                      Retry
                    </Button>
                  </p>
                ) : candidates.isSuccess && !list.length ? (
                  <p className="text-xs text-muted-foreground">
                    No one else is in this project yet.
                  </p>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-message`}>Message</FieldLabel>
                <Textarea
                  ref={messageRef}
                  id={`${formId}-message`}
                  required
                  rows={4}
                  maxLength={MAX_BODY}
                  value={body}
                  disabled={pending}
                  placeholder="What should they look at?"
                  onChange={(event) => setBody(event.target.value)}
                />
              </Field>
              {task ? (
                <p className="text-xs text-muted-foreground">
                  Task{" "}
                  <span className="font-mono text-foreground">{task.key}</span>{" "}
                  · {task.title}
                </p>
              ) : null}
              {send.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {handoffErrorMessage(send.error)}
                </p>
              ) : null}
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              disabled={pending || !selected || !body.trim()}
            >
              {pending ? "Sending…" : "Send ping"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <span role="status" className="text-xs text-muted-foreground">
        {sentTo ? `Ping sent to ${sentTo}` : ""}
      </span>
    </span>
  );
}
