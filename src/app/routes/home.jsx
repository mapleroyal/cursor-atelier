import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAppStore } from "@/stores/app-store";

const stack = [
  "Electron",
  "Vite",
  "React",
  "Tailwind",
  "shadcn/ui",
  "Router",
  "Zustand",
  "Query",
];

function fetchRuntimeVersions() {
  if (!window.electronAPI?.getVersions) {
    return {
      electron: "unavailable",
      chrome: "unavailable",
      node: "unavailable",
    };
  }

  return window.electronAPI.getVersions();
}

export function HomeRoute() {
  const ctaClicks = useAppStore((state) => state.ctaClicks);
  const theme = useAppStore((state) => state.theme);
  const themeSource = useAppStore((state) => state.themeSource);
  const incrementClicks = useAppStore((state) => state.incrementCtaClicks);
  const toggleTheme = useAppStore((state) => state.toggleTheme);
  const { data: versions } = useQuery({
    queryKey: ["runtime-versions"],
    queryFn: fetchRuntimeVersions,
  });

  return (
    <main className="min-h-screen bg-background p-6 text-foreground sm:p-10">
      <div className="mx-auto max-w-3xl">
        <Card>
          <CardHeader className="gap-4">
            <div className="flex flex-wrap gap-2">
              {stack.map((name) => (
                <Badge key={name} variant="secondary">
                  {name}
                </Badge>
              ))}
            </div>
            <div className="space-y-1">
              <CardTitle>Electron Template</CardTitle>
              <CardDescription>
                JavaScript-first Electron starter with Forge, Vite, Router,
                Zustand, Query, and shadcn/ui.
              </CardDescription>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            <Separator />
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Appearance</h2>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline">Active: {theme}</Badge>
                <Badge variant="outline">Source: {themeSource}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                App startup follows the current OS appearance. Manual changes
                are in-memory and reset when the app closes.
              </p>
            </section>
            <Separator />
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Runtime versions</h2>
              <div className="grid gap-2 text-sm sm:grid-cols-3">
                <p className="rounded-md border border-border p-3">
                  Electron: {versions?.electron ?? "loading..."}
                </p>
                <p className="rounded-md border border-border p-3">
                  Chrome: {versions?.chrome ?? "loading..."}
                </p>
                <p className="rounded-md border border-border p-3">
                  Node: {versions?.node ?? "loading..."}
                </p>
              </div>
            </section>
            <Separator />
            <p className="text-sm text-muted-foreground">
              CTA button clicked {ctaClicks} time(s).
            </p>
          </CardContent>

          <CardFooter>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={incrementClicks}>
                Update Zustand state
              </Button>
              <Button type="button" variant="outline" onClick={toggleTheme}>
                Switch to {theme === "dark" ? "light" : "dark"}
              </Button>
            </div>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
