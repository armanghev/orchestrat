import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "@/test/msw-server";

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
