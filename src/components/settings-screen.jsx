import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
  InformationCircleIcon,
  Settings02Icon,
  ShuffleIcon,
} from "@hugeicons/core-free-icons";

import { AppearanceModeSelector } from "@/components/appearance-mode-selector";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const SCHEDULE_OPTIONS = [
  ["off", "Off"],
  ["launch", "At app launch"],
  ["interval", "Every x hours"],
  ["daily", "Daily"],
  ["times", "Specific times"],
];

function getNextTime(times) {
  const occupied = new Set(times);
  for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
    const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
    const remainder = String(minutes % 60).padStart(2, "0");
    const candidate = `${hours}:${remainder}`;
    if (!occupied.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function SettingsSection({ icon, title, children }) {
  return (
    <Collapsible className="rounded-3xl border border-border/70">
      <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-3xl px-4 py-3 text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30">
        <span className="inline-flex items-center gap-2">
          <HugeiconsIcon
            icon={icon}
            strokeWidth={2}
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <span>{title}</span>
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent animated className="grid gap-4 px-4 pb-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function IntervalHoursInput({ value, onValueChange }) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(720, Math.max(0.25, Math.round(parsed * 4) / 4));
    setDraft(String(next));
    onValueChange(next);
  };

  return (
    <div className="flex w-full items-center gap-2 sm:w-52">
      <Input
        id="random-interval"
        type="number"
        inputMode="decimal"
        min="0.25"
        max="720"
        step="0.25"
        value={draft}
        className="text-right type-numeric"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
      />
      <span className="shrink-0 text-body-sm text-muted-foreground">hours</span>
    </div>
  );
}

function ScheduleFields({ schedule, onChange }) {
  const times = Array.isArray(schedule.times) ? schedule.times : [];
  const nextTime = getNextTime(times);

  if (schedule.mode === "interval") {
    return (
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="random-interval">Interval</FieldLabel>
        </FieldContent>
        <IntervalHoursInput
          value={schedule.intervalHours}
          onValueChange={(intervalHours) => onChange({ intervalHours })}
        />
      </Field>
    );
  }

  if (schedule.mode === "daily") {
    return (
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="random-daily-time">Time</FieldLabel>
        </FieldContent>
        <Input
          id="random-daily-time"
          type="time"
          value={schedule.dailyTime}
          className="type-numeric sm:w-52"
          onChange={(event) =>
            onChange({ dailyTime: event.currentTarget.value })
          }
        />
      </Field>
    );
  }

  if (schedule.mode !== "times") {
    return null;
  }

  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldLabel>Times</FieldLabel>
      </FieldContent>
      <div className="w-full min-w-0 space-y-2 sm:w-52">
        {times.map((time, index) => (
          <div key={index} className="flex min-w-0 items-center gap-1.5">
            <Input
              type="time"
              aria-label={`Random cursor time ${index + 1}`}
              value={time}
              className="type-numeric"
              onChange={(event) => {
                const nextTimes = [...times];
                nextTimes[index] = event.currentTarget.value;
                onChange({ times: nextTimes });
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${time}`}
              disabled={times.length <= 1}
              onClick={() =>
                onChange({
                  times: times.filter((_, timeIndex) => timeIndex !== index),
                })
              }
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                strokeWidth={2}
                aria-hidden="true"
              />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!nextTime}
          onClick={() => nextTime && onChange({ times: [...times, nextTime] })}
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden="true" />
          Add Time
        </Button>
      </div>
    </Field>
  );
}

export function SettingsScreen({
  packs,
  preferences,
  appearanceMode,
  onAppearanceModeChange,
  onChange,
  onRandomize,
  randomizing,
  feedback,
  onClose,
}) {
  const families = useMemo(
    () =>
      [
        ...new Set(
          (Array.isArray(packs) ? packs : [])
            .filter((pack) => pack?.canApply === true)
            .map((pack) => pack.family)
            .filter(Boolean),
        ),
      ].sort((left, right) => String(left).localeCompare(String(right))),
    [packs],
  );

  const randomization = preferences?.randomization ?? {};
  const schedule = randomization.schedule ?? {};
  const randomizationFeedback =
    feedback?.scope === "randomization" ? feedback : null;
  const preferenceError =
    feedback?.scope === "preferences" && feedback?.type === "error"
      ? feedback
      : null;
  const feedbackMessage =
    typeof randomizationFeedback === "string"
      ? randomizationFeedback
      : randomizationFeedback?.message;

  return (
    <section
      aria-labelledby="settings-title"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <header className="shrink-0 border-b border-border/60 px-4 sm:px-6 lg:px-8">
        <div className="relative mx-auto flex h-14 max-w-3xl items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            className="-ml-2 shrink-0"
            onClick={onClose}
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              strokeWidth={2}
              aria-hidden="true"
            />
          </Button>
          <h1
            id="settings-title"
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-title-md"
          >
            Settings
          </h1>
          <AppearanceModeSelector
            className="ml-auto"
            value={appearanceMode}
            onValueChange={onAppearanceModeChange}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6 lg:px-8">
        <div className="mx-auto grid w-full max-w-3xl gap-4 py-6">
          {preferenceError ? (
            <p role="alert" className="text-body-sm text-destructive">
              {preferenceError.message}
            </p>
          ) : null}

          <SettingsSection icon={Settings02Icon} title="General">
            <Field orientation="horizontal">
              <FieldContent>
                <div className="flex items-center gap-1.5">
                  <FieldLabel htmlFor="appearance-automatic-switching">
                    Switch Cursors with System Appearance
                  </FieldLabel>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label="About automatic cursor switching"
                            className="-my-1 text-muted-foreground"
                          />
                        }
                      >
                        <HugeiconsIcon
                          icon={InformationCircleIcon}
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-72">
                        Runs after its window closes, even without the menu bar
                        item. macOS Login Items controls launch at sign-in.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </FieldContent>
              <Switch
                id="appearance-automatic-switching"
                checked={preferences?.appearance?.automaticSwitching === true}
                onCheckedChange={(automaticSwitching) =>
                  onChange({ appearance: { automaticSwitching } })
                }
              />
            </Field>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="menu-bar-visible">
                  Show in Menu Bar
                </FieldLabel>
              </FieldContent>
              <Switch
                id="menu-bar-visible"
                checked={preferences?.menuBar?.visible !== false}
                onCheckedChange={(visible) =>
                  onChange({ menuBar: { visible } })
                }
              />
            </Field>
          </SettingsSection>

          <SettingsSection icon={ShuffleIcon} title="Randomization">
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
              {feedbackMessage ? (
                <p
                  role={
                    randomizationFeedback?.type === "error" ? "alert" : "status"
                  }
                  className={cn(
                    "mr-auto min-w-0 text-body-sm text-muted-foreground",
                    randomizationFeedback?.type === "error" &&
                      "text-destructive",
                  )}
                >
                  {feedbackMessage}
                </p>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={
                  randomizing ||
                  (randomization.source === "family" && !randomization.family)
                }
                onClick={onRandomize}
              >
                {randomizing ? "Randomizing…" : "Randomize Now"}
              </Button>
            </div>

            <Field orientation="responsive">
              <FieldContent>
                <FieldLabel htmlFor="random-source">Source</FieldLabel>
              </FieldContent>
              <Select
                value={randomization.source ?? "all"}
                onValueChange={(source) => {
                  onChange({
                    randomization: {
                      source,
                      ...(source === "family" && !randomization.family
                        ? { family: families[0] ?? null }
                        : {}),
                    },
                  });
                }}
              >
                <SelectTrigger id="random-source" className="w-full sm:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">Light &amp; Dark Pools</SelectItem>
                    <SelectItem value="favorites">Favorites</SelectItem>
                    <SelectItem value="family">Family</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {randomization.source === "family" ? (
              <Field orientation="responsive">
                <FieldContent>
                  <FieldLabel htmlFor="random-family">Family</FieldLabel>
                </FieldContent>
                <Select
                  value={randomization.family || undefined}
                  disabled={families.length === 0}
                  onValueChange={(family) =>
                    onChange({
                      randomization: {
                        family: family || null,
                      },
                    })
                  }
                >
                  <SelectTrigger id="random-family" className="w-full sm:w-52">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {families.map((family) => (
                        <SelectItem key={family} value={family}>
                          {family}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            <Field orientation="responsive">
              <FieldContent>
                <FieldLabel htmlFor="random-schedule">Schedule</FieldLabel>
              </FieldContent>
              <Select
                value={schedule.mode ?? "off"}
                onValueChange={(mode) =>
                  onChange({
                    randomization: {
                      schedule: { mode },
                    },
                  })
                }
              >
                <SelectTrigger id="random-schedule" className="w-full sm:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SCHEDULE_OPTIONS.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <ScheduleFields
              schedule={schedule}
              onChange={(schedulePatch) =>
                onChange({
                  randomization: { schedule: schedulePatch },
                })
              }
            />
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}
