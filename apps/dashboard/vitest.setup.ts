import "@testing-library/jest-dom/vitest";

const storageFrame = document.createElement("iframe");
document.body.append(storageFrame);
const storage = storageFrame.contentWindow?.localStorage;
if (!storage) throw new Error("Vitest jsdom localStorage is unavailable.");

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
  writable: true
});
