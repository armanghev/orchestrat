import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  entityLabel,
  entityName,
  description,
  pending,
  error,
  onConfirm
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityLabel: string;
  entityName: string;
  description: string;
  pending: boolean;
  error?: string | null;
  onConfirm: () => void | Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    if (!open) setConfirmation("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        showCloseButton={!pending}
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onPointerDownOutside={(event) => pending && event.preventDefault()}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmation === entityName) void onConfirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete {entityLabel}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="my-5 space-y-2">
            <Label htmlFor="delete-confirmation">
              Enter <span className="font-mono text-foreground">{entityName}</span> to continue
            </Label>
            <Input
              id="delete-confirmation"
              autoComplete="off"
              autoFocus
              disabled={pending}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={pending || confirmation !== entityName}
            >
              {pending ? "Deleting…" : `Delete ${entityLabel}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
