import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
  Moon02Icon,
  ShuffleIcon,
  Sun02Icon,
} from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { getCursorPreferenceId } from "@/lib/cursor-preferences";
import { cn } from "@/lib/utils";

const SCHEDULE_OPTIONS = [
  ["off", "Off"],
  ["launch", "At app launch"],
  ["interval", "Every x hours"],
  ["daily", "Daily"],
  ["times", "Specific times"],
];

function getPackLabel(pack) {
  const id = getCursorPreferenceId(pack) ?? "Cursor";
  const variant = String(pack?.variant ?? pack?.name ?? id);
  const family = pack?.family ? String(pack.family) : "";
  return family && family !== variant ? `${family} — ${variant}` : variant;
}

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

function SettingsRow({ label, htmlFor, children, className }) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] sm:items-center sm:gap-6",
        className,
      )}
    >
      <label
        htmlFor={htmlFor}
        className="min-w-0 text-body-md font-medium text-foreground"
      >
        {label}
      </label>
      <div className="flex min-w-0 items-center justify-start sm:justify-end">
        {children}
      </div>
    </div>
  );
}

function CursorSelect({ id, value, packs, disabled, onValueChange }) {
  const valueAvailable = packs.some(
    (pack) => getCursorPreferenceId(pack) === value,
  );

  return (
    <NativeSelect
      id={id}
      value={value ?? ""}
      disabled={disabled || packs.length === 0}
      className="w-full"
      onChange={(event) => onValueChange(event.currentTarget.value || null)}
    >
      <NativeSelectOption value="">None</NativeSelectOption>
      {value && !valueAvailable ? (
        <NativeSelectOption value={value}>
          Unavailable cursor
        </NativeSelectOption>
      ) : null}
      {packs.map((pack) => {
        const preferenceId = getCursorPreferenceId(pack);
        return (
          <NativeSelectOption key={preferenceId} value={preferenceId}>
            {getPackLabel(pack)}
          </NativeSelectOption>
        );
      })}
    </NativeSelect>
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
    <div className="flex w-full items-center gap-2">
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
      <SettingsRow label="Interval" htmlFor="random-interval">
        <IntervalHoursInput
          value={schedule.intervalHours}
          onValueChange={(intervalHours) => onChange({ intervalHours })}
        />
      </SettingsRow>
    );
  }

  if (schedule.mode === "daily") {
    return (
      <SettingsRow label="Time" htmlFor="random-daily-time">
        <Input
          id="random-daily-time"
          type="time"
          value={schedule.dailyTime}
          className="type-numeric"
          onChange={(event) =>
            onChange({ dailyTime: event.currentTarget.value })
          }
        />
      </SettingsRow>
    );
  }

  if (schedule.mode !== "times") {
    return null;
  }

  return (
    <div className="grid min-w-0 gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] sm:gap-6">
      <span className="text-body-md font-medium text-foreground">Times</span>
      <div className="min-w-0 space-y-2">
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
    </div>
  );
}

export function SettingsScreen({
  packs,
  preferences,
  onChange,
  onRandomize,
  randomizing,
  feedback,
  onClose,
}) {
  const selectablePacks = useMemo(() => {
    const unique = new Map();
    for (const pack of Array.isArray(packs) ? packs : []) {
      const preferenceId = getCursorPreferenceId(pack);
      if (
        preferenceId &&
        pack?.canApply === true &&
        !unique.has(preferenceId)
      ) {
        unique.set(preferenceId, pack);
      }
    }
    return [...unique.values()].sort((left, right) =>
      getPackLabel(left).localeCompare(getPackLabel(right)),
    );
  }, [packs]);

  const families = useMemo(
    () =>
      [
        ...new Set(selectablePacks.map((pack) => pack.family).filter(Boolean)),
      ].sort((left, right) => String(left).localeCompare(String(right))),
    [selectablePacks],
  );

  const appearance = preferences?.appearance ?? {};
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
        <div className="relative mx-auto flex h-14 max-w-3xl items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            className="-ml-2"
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
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-3xl">
          {preferenceError ? (
            <p role="alert" className="pt-4 text-body-sm text-destructive">
              {preferenceError.message}
            </p>
          ) : null}
          <section className="py-6" aria-labelledby="settings-general">
            <h2 id="settings-general" className="text-title-md">
              General
            </h2>
            <div className="mt-3">
              <SettingsRow label="Menu Bar Item" htmlFor="menu-bar-visible">
                <Switch
                  id="menu-bar-visible"
                  checked={preferences?.menuBar?.visible !== false}
                  onCheckedChange={(visible) =>
                    onChange({ menuBar: { visible } })
                  }
                />
              </SettingsRow>
            </div>
          </section>

          <Separator />

          <section className="py-6" aria-labelledby="settings-appearance">
            <h2 id="settings-appearance" className="text-title-md">
              Appearance
            </h2>
            <div className="mt-3">
              <SettingsRow
                label="Appearance-aware Cursors"
                htmlFor="appearance-aware"
              >
                <Switch
                  id="appearance-aware"
                  checked={appearance.enabled === true}
                  onCheckedChange={(enabled) =>
                    onChange({ appearance: { enabled } })
                  }
                />
              </SettingsRow>
              <SettingsRow
                label={
                  <span className="flex items-center gap-2">
                    <HugeiconsIcon
                      icon={Sun02Icon}
                      strokeWidth={2}
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    Light
                  </span>
                }
                htmlFor="light-cursor"
              >
                <CursorSelect
                  id="light-cursor"
                  value={appearance.lightCursorId}
                  packs={selectablePacks}
                  disabled={!appearance.enabled}
                  onValueChange={(lightCursorId) =>
                    onChange({ appearance: { lightCursorId } })
                  }
                />
              </SettingsRow>
              <SettingsRow
                label={
                  <span className="flex items-center gap-2">
                    <HugeiconsIcon
                      icon={Moon02Icon}
                      strokeWidth={2}
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    Dark
                  </span>
                }
                htmlFor="dark-cursor"
              >
                <CursorSelect
                  id="dark-cursor"
                  value={appearance.darkCursorId}
                  packs={selectablePacks}
                  disabled={!appearance.enabled}
                  onValueChange={(darkCursorId) =>
                    onChange({ appearance: { darkCursorId } })
                  }
                />
              </SettingsRow>
            </div>
          </section>

          <Separator />

          <section className="py-6" aria-labelledby="settings-randomization">
            <h2 id="settings-randomization" className="text-title-md">
              Randomization
            </h2>
            <div className="mt-3">
              <SettingsRow label="Source" htmlFor="random-source">
                <NativeSelect
                  id="random-source"
                  value={randomization.source ?? "all"}
                  className="w-full"
                  onChange={(event) => {
                    const source = event.currentTarget.value;
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
                  <NativeSelectOption value="all">All</NativeSelectOption>
                  <NativeSelectOption value="favorites">
                    Favorites
                  </NativeSelectOption>
                  <NativeSelectOption value="family">Family</NativeSelectOption>
                </NativeSelect>
              </SettingsRow>

              {randomization.source === "family" ? (
                <SettingsRow label="Family" htmlFor="random-family">
                  <NativeSelect
                    id="random-family"
                    value={randomization.family ?? ""}
                    disabled={families.length === 0}
                    className="w-full"
                    onChange={(event) =>
                      onChange({
                        randomization: {
                          family: event.currentTarget.value || null,
                        },
                      })
                    }
                  >
                    {families.length === 0 ? (
                      <NativeSelectOption value="">None</NativeSelectOption>
                    ) : null}
                    {families.map((family) => (
                      <NativeSelectOption key={family} value={family}>
                        {family}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </SettingsRow>
              ) : null}

              <div className="grid min-w-0 gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] sm:items-center sm:gap-6">
                <div
                  role={
                    randomizationFeedback?.type === "error" ? "alert" : "status"
                  }
                  className={cn(
                    "min-h-4 text-body-sm text-muted-foreground",
                    randomizationFeedback?.type === "error" &&
                      "text-destructive",
                  )}
                >
                  {feedbackMessage ?? null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    randomizing ||
                    (randomization.source === "family" && !randomization.family)
                  }
                  className="w-full"
                  onClick={onRandomize}
                >
                  <HugeiconsIcon
                    icon={ShuffleIcon}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  {randomizing ? "Randomizing…" : "New Random Cursor"}
                </Button>
              </div>
            </div>
          </section>

          <Separator />

          <section className="py-6" aria-labelledby="settings-schedule">
            <h2 id="settings-schedule" className="text-title-md">
              Schedule
            </h2>
            <div className="mt-3">
              <SettingsRow label="Run" htmlFor="random-schedule">
                <NativeSelect
                  id="random-schedule"
                  value={schedule.mode ?? "off"}
                  className="w-full"
                  onChange={(event) =>
                    onChange({
                      randomization: {
                        schedule: { mode: event.currentTarget.value },
                      },
                    })
                  }
                >
                  {SCHEDULE_OPTIONS.map(([value, label]) => (
                    <NativeSelectOption key={value} value={value}>
                      {label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </SettingsRow>
              <ScheduleFields
                schedule={schedule}
                onChange={(schedulePatch) =>
                  onChange({
                    randomization: { schedule: schedulePatch },
                  })
                }
              />
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
