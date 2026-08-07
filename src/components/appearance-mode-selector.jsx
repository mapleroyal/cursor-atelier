import { useCallback } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ComputerIcon,
  Moon02Icon,
  Sun02Icon,
} from "@hugeicons/core-free-icons";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const APPEARANCE_OPTIONS = [
  { value: "light", label: "Light", icon: Sun02Icon },
  { value: "system", label: "System", icon: ComputerIcon },
  { value: "dark", label: "Dark", icon: Moon02Icon },
];

const APPEARANCE_INDEXES = {
  light: 0,
  system: 1,
  dark: 2,
};

export function AppearanceModeSelector({ className, value, onValueChange }) {
  const handleKeyDown = useCallback(
    (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) {
        return;
      }

      const currentIndex = APPEARANCE_OPTIONS.findIndex(
        (option) => option.value === target.dataset.appearanceValue,
      );
      if (currentIndex < 0) {
        return;
      }

      let nextIndex;
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowUp":
          nextIndex =
            (currentIndex - 1 + APPEARANCE_OPTIONS.length) %
            APPEARANCE_OPTIONS.length;
          break;
        case "ArrowRight":
        case "ArrowDown":
          nextIndex = (currentIndex + 1) % APPEARANCE_OPTIONS.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = APPEARANCE_OPTIONS.length - 1;
          break;
        default:
          return;
      }

      event.preventDefault();
      const next = APPEARANCE_OPTIONS[nextIndex];
      onValueChange(next.value);
      event.currentTarget
        .querySelector(`[data-appearance-value="${next.value}"]`)
        ?.focus({ preventScroll: true });
    },
    [onValueChange],
  );

  return (
    <TooltipProvider>
      <div
        aria-label="Appearance mode"
        className={cn(
          "relative grid h-8 w-[6.5rem] shrink-0 grid-cols-3 items-center rounded-4xl bg-muted p-0.5 shadow-inner",
          className,
        )}
        role="radiogroup"
        style={{ "--appearance-index": APPEARANCE_INDEXES[value] ?? 1 }}
        onKeyDown={handleKeyDown}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0.5 left-0.5 h-7 w-[calc((100%-0.25rem)/3)] rounded-4xl border border-border/70 bg-background shadow-sm transition-transform duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none"
          style={{
            transform: "translateX(calc(var(--appearance-index) * 100%))",
          }}
        />

        {APPEARANCE_OPTIONS.map((option) => (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-checked={value === option.value}
                aria-label={option.label}
                className={cn(
                  "relative z-10 flex h-full w-full items-center justify-center rounded-full bg-transparent text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                  value === option.value && "text-foreground",
                )}
                data-appearance-value={option.value}
                role="radio"
                tabIndex={value === option.value ? 0 : -1}
                onClick={() => onValueChange(option.value)}
              >
                <HugeiconsIcon
                  icon={option.icon}
                  aria-hidden="true"
                  className="size-3.5"
                  strokeWidth={2.2}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{option.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
