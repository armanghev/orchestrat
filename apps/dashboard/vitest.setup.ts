import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "@/test/msw-server";

class IdleTestWebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = this.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {}

  close() {
    this.readyState = this.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  send() {}
}

Object.defineProperty(globalThis, "WebSocket", {
  configurable: true,
  value: IdleTestWebSocket,
  writable: true
});

const storageFrame = document.createElement("iframe");
document.body.append(storageFrame);
const storage = storageFrame.contentWindow?.localStorage;
if (!storage) throw new Error("Vitest jsdom localStorage is unavailable.");

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
  writable: true
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
