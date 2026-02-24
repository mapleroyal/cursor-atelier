import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { router } from "@/app/router";
import { ThemeSync } from "@/app/theme-sync";
import { queryClient } from "@/lib/query-client";
import "@/globals.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing root element in index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
