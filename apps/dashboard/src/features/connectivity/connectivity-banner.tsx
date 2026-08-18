import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { hierarchyKeys } from "@/features/hierarchy/query-options";

function getOnlineSnapshot(): boolean {
  return navigator.onLine;
}

export function ConnectivityBanner() {
  const queryClient = useQueryClient();
  const handleOnline = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
  }, [queryClient]);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const online = () => {
        onStoreChange();
        handleOnline();
      };
      const offline = () => onStoreChange();
      window.addEventListener("online", online);
      window.addEventListener("offline", offline);
      return () => {
        window.removeEventListener("online", online);
        window.removeEventListener("offline", offline);
      };
    },
    [handleOnline]
  );
  const isOnline = useSyncExternalStore(
    subscribe,
    getOnlineSnapshot,
    () => true
  );

  if (isOnline) return null;
  return (
    <div
      role="status"
      className="mx-3 mt-2 rounded-md border px-3 py-2 text-sm text-muted-foreground"
    >
      Offline — showing cached project data.
    </div>
  );
}
