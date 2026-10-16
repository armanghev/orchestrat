import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useBranch } from "./branch-context";

/** A deep link to an item on another branch of this project offers to switch
 * there instead of a dead end. */
export function OtherBranchNotice({
  item,
  branchId,
  onSwitch,
  className
}: {
  item: "task" | "document" | "conversation";
  branchId: string;
  onSwitch: () => void;
  className?: string;
}) {
  const { branchName } = useBranch();
  const name = branchName(branchId);
  return (
    <Alert role="status" className={cn("w-auto", className)}>
      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span>
          This {item} is on{" "}
          {name ? (
            <span className="font-medium text-foreground">{name}</span>
          ) : (
            "another branch"
          )}
          .
        </span>
        {name ? (
          <Button type="button" size="sm" variant="outline" onClick={onSwitch}>
            Switch to {name}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
