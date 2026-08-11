export type LogContext = Record<string, string | number | boolean | undefined>;
export interface Logger {
  info(context: LogContext, message: string): void;
  error(context: LogContext, message: string): void;
}
export const logger: Logger = {
  info: (context, message) =>
    console.info(JSON.stringify({ level: "info", message, ...context })),
  error: (context, message) =>
    console.error(JSON.stringify({ level: "error", message, ...context }))
};
