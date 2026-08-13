import { ClerkProvider } from "@clerk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app";
import "./styles.css";

const queryClient = new QueryClient();
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const root = createRoot(document.getElementById("root")!);

if (!publishableKey) {
  root.render(
    <main className="configuration-error">
      <p className="eyebrow">CONFIGURATION REQUIRED</p>
      <h1>Set VITE_CLERK_PUBLISHABLE_KEY</h1>
      <p>Copy the Clerk publishable key into the repository .env file.</p>
    </main>
  );
} else {
  root.render(
    <ClerkProvider publishableKey={publishableKey}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ClerkProvider>
  );
}
