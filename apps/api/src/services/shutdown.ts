import { logger } from "@orchestrat/logger";

export const createShutdownHandler = (
  close: () => Promise<void>,
  timeoutMs = 10_000,
  exit: (code: number) => void = process.exit
) => {
  let started = false;
  return (signal: NodeJS.Signals) => {
    if (started) return;
    started = true;
    logger.info({ signal }, "API shutdown started");
    const timeout = setTimeout(() => {
      logger.error({ signal, timeout_ms: timeoutMs }, "API shutdown timed out");
      exit(1);
    }, timeoutMs);
    void close().then(
      () => {
        clearTimeout(timeout);
        logger.info({ signal }, "API shutdown complete");
      },
      (error: unknown) => {
        clearTimeout(timeout);
        logger.error(
          {
            error: error instanceof Error ? error.message : String(error),
            signal
          },
          "API shutdown failed"
        );
        exit(1);
      }
    );
  };
};
