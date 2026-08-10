import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function PackPreviews({ pack }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center -space-x-1">
      {pack.previews.map((src, index) => (
        <span
          key={src}
          className="grid size-10 place-items-center rounded-2xl border border-background/80 bg-muted shadow-sm"
          style={{ zIndex: pack.previews.length - index }}
        >
          <img src={src} alt="" className="size-7 object-contain" />
        </span>
      ))}
    </span>
  );
}

export function OnboardingScreen({ families, onContinue }) {
  const allIds = useMemo(() => families.map((family) => family.id), [families]);
  const [selectedIds, setSelectedIds] = useState(() => new Set(allIds));
  const [submitting, setSubmitting] = useState(false);

  const toggle = (id) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const continueOnboarding = () => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    onContinue(allIds.filter((id) => selectedIds.has(id)));
  };

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background">
      <div className="titlebar-drag h-12 shrink-0" />
      <section className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-5 pb-5 sm:px-8 sm:pb-8">
        <header className="shrink-0 pb-4">
          <h1 className="text-headline-lg">Start with any cursor packs?</h1>
          <p className="mt-1 text-body-md text-muted-foreground">
            All are selected by default. Click any pack to deselect it.
          </p>
        </header>

        <div className="mb-2 flex shrink-0 justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds(new Set(allIds))}
          >
            Select all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds(new Set())}
          >
            Deselect all
          </Button>
        </div>

        <div
          role="group"
          aria-label="Starter cursor packs"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-y border-border/70 py-1"
        >
          {families.map((family) => {
            const selected = selectedIds.has(family.id);
            return (
              <button
                key={family.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggle(family.id)}
                className={cn(
                  "group flex min-h-16 w-full items-center gap-4 border-b border-border/60 px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
                  selected
                    ? "text-foreground"
                    : "text-muted-foreground opacity-50 hover:opacity-80",
                )}
              >
                <PackPreviews pack={family} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-title-md text-foreground">
                    {family.family}
                  </span>
                  <span className="block truncate text-body-sm text-muted-foreground">
                    {family.variant}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border transition-colors",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background",
                  )}
                >
                  {selected ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      strokeWidth={2.5}
                      className="size-3.5"
                    />
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>

        <footer className="flex shrink-0 justify-end pt-5">
          <Button
            type="button"
            size="lg"
            disabled={submitting}
            onClick={continueOnboarding}
            className="min-w-28"
          >
            Continue
          </Button>
        </footer>
      </section>
    </main>
  );
}
