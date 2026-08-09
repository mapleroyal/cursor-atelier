import { useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";

import { AppearanceModeSelector } from "@/components/appearance-mode-selector";
import { Button } from "@/components/ui/button";
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
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function areValidTimes(times) {
  return (
    times.every((time) => TIME_PATTERN.test(time)) &&
    new Set(times).size === times.length
  );
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

function SettingsSection({ title, children }) {
  return (
    <section className="grid gap-5 py-6 first:pt-0 last:pb-0">
      <h2 className="text-title-md">{title}</h2>
      {children}
    </section>
  );
}

function saveDraft(save, restore) {
  try {
    void Promise.resolve(save()).then((saved) => {
      if (saved === false) {
        restore();
      }
    }, restore);
  } catch {
    restore();
  }
}

function IntervalHoursInput({ value, disabled, onValueChange }) {
  const [draft, setDraft] = useState(String(value));
  const cancelBlurRef = useRef(false);

  const commit = () => {
    if (cancelBlurRef.current) {
      cancelBlurRef.current = false;
      return;
    }
    if (!draft.trim()) {
      setDraft(String(value));
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(720, Math.max(0.25, Math.round(parsed * 4) / 4));
    setDraft(String(next));
    if (next !== Number(value)) {
      saveDraft(
        () => onValueChange(next),
        () => setDraft(String(value)),
      );
    }
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
        disabled={disabled}
        className="text-right type-numeric"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            cancelBlurRef.current = true;
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
      />
      <span className="shrink-0 text-body-sm text-muted-foreground">hours</span>
    </div>
  );
}

function DailyTimeInput({ value, disabled, onValueChange }) {
  const [draft, setDraft] = useState(value);
  const cancelBlurRef = useRef(false);

  const commit = () => {
    if (cancelBlurRef.current) {
      cancelBlurRef.current = false;
      return;
    }
    if (!TIME_PATTERN.test(draft)) {
      setDraft(value);
      return;
    }
    if (draft !== value) {
      saveDraft(
        () => onValueChange(draft),
        () => setDraft(value),
      );
    }
  };

  return (
    <Input
      id="random-daily-time"
      type="time"
      value={draft}
      className="type-numeric sm:w-52"
      disabled={disabled}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          cancelBlurRef.current = true;
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function SpecificTimesInput({ times, disabled, onValueChange }) {
  const [rows, setRows] = useState(() =>
    times.map((time, index) => ({ id: `${index}-${time}`, value: time })),
  );
  const canceledBlurRef = useRef(new Set());
  const rowValues = rows.map((row) => row.value);
  const rowsAreValid = areValidTimes(rowValues);
  const nextTime = rowsAreValid ? getNextTime(rowValues) : null;

  const restoreRows = () =>
    setRows(
      times.map((time, index) => ({ id: `${index}-${time}`, value: time })),
    );

  const updateRow = (id, value) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, value } : row)),
    );
  };

  const commitRows = (rowId) => {
    if (canceledBlurRef.current.delete(rowId)) {
      return;
    }
    const nextTimes = rows.map((row) => row.value);
    if (!areValidTimes(nextTimes)) {
      restoreRows();
      return;
    }
    if (nextTimes.some((time, index) => time !== times[index])) {
      saveDraft(() => onValueChange(nextTimes), restoreRows);
    }
  };

  return (
    <div className="w-full min-w-0 space-y-2 sm:w-52">
      {rows.map((row, index) => (
        <div key={row.id} className="flex min-w-0 items-center gap-1.5">
          <Input
            type="time"
            aria-label={`Random cursor time ${index + 1}`}
            value={row.value}
            className="type-numeric"
            disabled={disabled}
            onChange={(event) => updateRow(row.id, event.currentTarget.value)}
            onBlur={() => commitRows(row.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                canceledBlurRef.current.add(row.id);
                updateRow(row.id, times[index] ?? "");
                event.currentTarget.blur();
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${row.value || `time ${index + 1}`}`}
            disabled={
              disabled ||
              rows.length <= 1 ||
              !areValidTimes(
                rows
                  .filter((candidate) => candidate.id !== row.id)
                  .map((candidate) => candidate.value),
              )
            }
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const nextTimes = rows
                .filter((candidate) => candidate.id !== row.id)
                .map((candidate) => candidate.value);
              saveDraft(() => onValueChange(nextTimes), restoreRows);
            }}
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
        disabled={disabled || !rowsAreValid || !nextTime}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (!nextTime) {
            return;
          }
          saveDraft(() => onValueChange([...rowValues, nextTime]), restoreRows);
        }}
      >
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden="true" />
        Add Time
      </Button>
    </div>
  );
}

function ScheduleFields({ schedule, disabled, onChange }) {
  const times = Array.isArray(schedule.times) ? schedule.times : [];

  if (schedule.mode === "interval") {
    return (
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="random-interval">Interval</FieldLabel>
        </FieldContent>
        <IntervalHoursInput
          key={schedule.intervalHours}
          value={schedule.intervalHours}
          disabled={disabled}
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
        <DailyTimeInput
          key={schedule.dailyTime}
          value={schedule.dailyTime}
          disabled={disabled}
          onValueChange={(dailyTime) => onChange({ dailyTime })}
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
      <SpecificTimesInput
        key={times.join("|")}
        times={times}
        disabled={disabled}
        onValueChange={(nextTimes) => onChange({ times: nextTimes })}
      />
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
  busy,
  canRandomize,
  preferencesAvailable,
  preferencesError,
  preferencesErrorMessage,
  preferencesRetrying,
  onRetryPreferences,
  themeError,
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
  const settingsDisabled = busy || !preferencesAvailable;
  const displayedPreferenceError = preferencesError
    ? preferencesErrorMessage
    : preferenceError?.message;

  return (
    <section
      aria-labelledby="settings-title"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <header className="titlebar-drag relative h-12 shrink-0 border-b border-border/60 pr-3 pl-[78px] sm:pr-4">
        <div className="mx-auto flex h-full max-w-3xl items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            className="titlebar-no-drag shrink-0"
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
            className="titlebar-no-drag ml-auto"
            value={appearanceMode}
            onValueChange={onAppearanceModeChange}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-3xl py-6">
          {displayedPreferenceError || themeError ? (
            <div className="grid gap-2 pb-5">
              {displayedPreferenceError ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-destructive"
                >
                  <span>{displayedPreferenceError}</span>
                  {preferencesError ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="-my-1"
                      onClick={onRetryPreferences}
                      disabled={preferencesRetrying}
                    >
                      {preferencesRetrying ? "Retrying…" : "Retry"}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {themeError ? (
                <p role="alert" className="text-body-sm text-destructive">
                  {themeError}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="divide-y divide-border/60">
            <SettingsSection title="General">
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
                          Runs after its window closes, even without the menu
                          bar item. macOS Login Items controls launch at
                          sign-in.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </FieldContent>
                <Switch
                  id="appearance-automatic-switching"
                  checked={preferences?.appearance?.automaticSwitching === true}
                  disabled={settingsDisabled}
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
                  disabled={settingsDisabled}
                  onCheckedChange={(visible) =>
                    onChange({ menuBar: { visible } })
                  }
                />
              </Field>
            </SettingsSection>

            <SettingsSection title="Randomization">
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
                {feedbackMessage ? (
                  <p
                    role={
                      randomizationFeedback?.type === "error"
                        ? "alert"
                        : "status"
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
                    settingsDisabled ||
                    !canRandomize ||
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
                  disabled={settingsDisabled}
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
                      <SelectItem value="all">
                        Light &amp; Dark Pools
                      </SelectItem>
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
                    disabled={settingsDisabled || families.length === 0}
                    onValueChange={(family) =>
                      onChange({
                        randomization: {
                          family: family || null,
                        },
                      })
                    }
                  >
                    <SelectTrigger
                      id="random-family"
                      className="w-full sm:w-52"
                    >
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
                  disabled={settingsDisabled}
                  onValueChange={(mode) =>
                    onChange({
                      randomization: {
                        schedule: { mode },
                      },
                    })
                  }
                >
                  <SelectTrigger
                    id="random-schedule"
                    className="w-full sm:w-52"
                  >
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
                disabled={settingsDisabled}
                onChange={(schedulePatch) =>
                  onChange({
                    randomization: { schedule: schedulePatch },
                  })
                }
              />
            </SettingsSection>
          </div>
        </div>
      </div>
    </section>
  );
}
