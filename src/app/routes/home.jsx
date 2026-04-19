import { useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CommandIcon,
  DashboardSquare01Icon,
  Moon02Icon,
  PaintBrushIcon,
  Sun02Icon,
} from "@hugeicons/core-free-icons";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAppStore } from "@/stores/app-store";

const STACK = [
  { label: "Electron", href: "https://www.electronjs.org" },
  { label: "Electron Forge", href: "https://www.electronforge.io" },
  { label: "React 19", href: "https://react.dev" },
  { label: "React Router v7", href: "https://reactrouter.com" },
  { label: "Vite", href: "https://vite.dev" },
  { label: "Tailwind v4", href: "https://tailwindcss.com" },
  { label: "shadcn/ui", href: "https://ui.shadcn.com" },
  { label: "Zustand", href: "https://zustand.docs.pmnd.rs" },
  { label: "Query", href: "https://tanstack.com/query/latest" },
];

const DETAILS = [
  {
    icon: PaintBrushIcon,
    title: "radix-maia",
    description: "Soft, rounded shadcn style with Geist font and Hugeicons.",
  },
  {
    icon: DashboardSquare01Icon,
    title: "55 components",
    description: "The full shadcn/ui component set is installed and ready.",
  },
  {
    icon: CommandIcon,
    title: "Electron shell",
    description:
      "Forge, preload bridging, Router, Query, and Zustand stay wired for desktop apps.",
  },
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

function GettingStarted() {
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="quick-start">
        <AccordionTrigger className="text-title-md">
          Quick start
        </AccordionTrigger>
        <AccordionContent>
          <div className="space-y-3">
            <p className="text-body-sm text-muted-foreground">
              Start the Electron renderer, main process, and preload bridge in
              one command.
            </p>
            <div className="rounded-xl bg-muted/50 p-3 font-mono text-body-sm">
              <div className="text-muted-foreground">
                <span className="text-primary">$</span>{" "}
                <span className="text-foreground">npm start</span>
              </div>
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="structure">
        <AccordionTrigger className="text-title-md">
          Project structure
        </AccordionTrigger>
        <AccordionContent>
          <div className="grid grid-cols-2 gap-2">
            {[
              ["src/app/routes/", "Renderer routes"],
              ["src/components/ui/", "55 shadcn components"],
              ["src/main.js", "Electron main process"],
              ["src/preload.js", "Renderer bridge"],
            ].map(([path, description]) => (
              <div key={path}>
                <code className="font-mono text-body-sm text-foreground">
                  {path}
                </code>
                <p className="text-body-sm text-muted-foreground">
                  {description}
                </p>
              </div>
            ))}
          </div>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="scripts">
        <AccordionTrigger className="text-title-md">Scripts</AccordionTrigger>
        <AccordionContent>
          <div className="grid grid-cols-3 gap-3 text-center">
            {[
              ["npm start", "Develop"],
              ["npm run package", "Package"],
              ["npm test", "Test"],
            ].map(([command, label]) => (
              <div key={command}>
                <code className="font-mono text-body-sm text-foreground">
                  {command}
                </code>
                <p className="text-body-sm text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export function HomeRoute() {
  const theme = useAppStore((state) => state.theme);
  const toggleTheme = useAppStore((state) => state.toggleTheme);
  const { data: versions } = useQuery({
    queryKey: ["runtime-versions"],
    queryFn: fetchRuntimeVersions,
  });

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-center justify-center p-6">
      <div className="w-full space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2.5">
              <h1 className="text-display-sm">Electron Template</h1>
              <Badge variant="secondary">Desktop</Badge>
            </div>
            <p className="type-measure text-body-md text-muted-foreground">
              Desktop scaffold with the same shadcn, Tailwind, and theme stack
              as the React template, plus Electron main and preload wiring.
            </p>
          </div>
          <Button
            onClick={toggleTheme}
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle theme"
          >
            <HugeiconsIcon
              icon={theme === "dark" ? Sun02Icon : Moon02Icon}
              strokeWidth={2}
            />
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {STACK.map(({ label, href }) => (
            <a key={label} href={href} target="_blank" rel="noreferrer">
              <Badge
                variant="outline"
                className="cursor-pointer transition-colors hover:bg-accent"
              >
                {label}
              </Badge>
            </a>
          ))}
        </div>

        <Separator />

        <div className="grid gap-3 sm:grid-cols-3">
          {DETAILS.map(({ icon, title, description }) => (
            <Card key={title} className="bg-card/60">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <HugeiconsIcon
                    icon={icon}
                    strokeWidth={2}
                    className="size-4 text-primary"
                  />
                  <CardTitle className="text-title-lg">{title}</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription className="text-body-sm text-muted-foreground">
                  {description}
                </CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>

        <Separator />

        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-headline-sm">Runtime versions</h2>
            <p className="type-measure text-body-sm text-muted-foreground">
              Values come from the preload bridge so the renderer stays
              sandboxed while still exposing runtime metadata.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Electron", versions?.electron ?? "loading..."],
              ["Chrome", versions?.chrome ?? "loading..."],
              ["Node", versions?.node ?? "loading..."],
            ].map(([label, value]) => (
              <Card key={label} size="sm" className="bg-card/60">
                <CardHeader className="pb-1">
                  <CardTitle className="text-title-lg">{label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="font-mono text-body-sm text-muted-foreground">
                    {value}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <Separator />

        <GettingStarted />
      </div>
    </main>
  );
}
