import { useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Cancel01Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";

import { AppearanceModeSelector } from "@/components/appearance-mode-selector";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { SheetClose, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isLinux } from "@/lib/platform";

const SCHEDULE_OPTIONS = [
  ["launch", "At app launch"],
  ["interval", "Every x hours"],
  ["daily", "Daily"],
  ["times", "Specific times"],
];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function areValidTimes(times) {
  return getTimesValidationMessage(times) === null;
}

export function getTimesValidationMessage(times) {
  if (times.some((time) => !TIME_PATTERN.test(time))) {
    return "Enter a valid time.";
  }
  if (new Set(times).size !== times.length) {
    return "Times must be unique.";
  }
  return null;
}

export function getNextTime(times) {
  const occupied = new Set(times);
  const lastTime = times.at(-1);
  const [lastHour, lastMinute] = TIME_PATTERN.test(lastTime)
    ? lastTime.split(":").map(Number)
    : [0, -15];
  const start = (lastHour * 60 + lastMinute + 15) % (24 * 60);
  for (let offset = 0; offset < 24 * 60; offset += 15) {
    const minutes = (start + offset) % (24 * 60);
    const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
    const remainder = String(minutes % 60).padStart(2, "0");
    const candidate = `${hours}:${remainder}`;
    if (!occupied.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function reconcileTimeRows(rows, times, createRow) {
  const rowsByValue = new Map();
  for (const row of rows) {
    const matchingRows = rowsByValue.get(row.value) ?? [];
    matchingRows.push(row);
    rowsByValue.set(row.value, matchingRows);
  }

  return times.map((time) => {
    const matchingRows = rowsByValue.get(time);
    return matchingRows?.shift() ?? createRow(time);
  });
}

function SettingsSection({ title, action, children }) {
  return (
    <section className="grid gap-5 py-6 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2 className="text-title-md">{title}</h2>
        {action}
      </div>
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
  const [validationMessage, setValidationMessage] = useState(null);
  const cancelBlurRef = useRef(false);

  const commit = () => {
    if (cancelBlurRef.current) {
      cancelBlurRef.current = false;
      return;
    }
    const parsed = Number(draft);
    if (
      !draft.trim() ||
      !Number.isFinite(parsed) ||
      parsed < 0.25 ||
      parsed > 720
    ) {
      setValidationMessage("Enter 0.25–720 hours.");
      return;
    }
    const next = Math.min(720, Math.max(0.25, Math.round(parsed * 4) / 4));
    setValidationMessage(null);
    setDraft(String(next));
    if (next !== Number(value)) {
      saveDraft(
        () => onValueChange(next),
        () => setDraft(String(value)),
      );
    }
  };

  return (
    <div className="w-full sm:w-52">
      <div className="flex items-center gap-2">
        <Input
          id="random-interval"
          type="number"
          inputMode="decimal"
          min="0.25"
          max="720"
          step="0.25"
          value={draft}
          disabled={disabled}
          aria-invalid={validationMessage ? "true" : undefined}
          className="text-right type-numeric"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setValidationMessage(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              cancelBlurRef.current = true;
              setDraft(String(value));
              setValidationMessage(null);
              event.currentTarget.blur();
            }
          }}
        />
        <span className="shrink-0 text-body-sm text-muted-foreground">
          hours
        </span>
      </div>
      {validationMessage ? (
        <p role="alert" className="mt-1.5 text-body-sm text-destructive">
          {validationMessage}
        </p>
      ) : null}
    </div>
  );
}

function DailyTimeInput({ value, disabled, onValueChange }) {
  const [draft, setDraft] = useState(value);
  const [validationMessage, setValidationMessage] = useState(null);
  const cancelBlurRef = useRef(false);

  const commit = () => {
    if (cancelBlurRef.current) {
      cancelBlurRef.current = false;
      return;
    }
    if (!TIME_PATTERN.test(draft)) {
      setValidationMessage("Enter a valid time.");
      return;
    }
    setValidationMessage(null);
    if (draft !== value) {
      saveDraft(
        () => onValueChange(draft),
        () => setDraft(value),
      );
    }
  };

  return (
    <div className="w-full sm:w-52">
      <Input
        id="random-daily-time"
        type="time"
        value={draft}
        className="type-numeric"
        disabled={disabled}
        aria-invalid={validationMessage ? "true" : undefined}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setValidationMessage(null);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            cancelBlurRef.current = true;
            setDraft(value);
            setValidationMessage(null);
            event.currentTarget.blur();
          }
        }}
      />
      {validationMessage ? (
        <p role="alert" className="mt-1.5 text-body-sm text-destructive">
          {validationMessage}
        </p>
      ) : null}
    </div>
  );
}

function SpecificTimesInput({ times, disabled, onValueChange }) {
  const timesSignature = JSON.stringify(times);
  const authoritativeTimes = useMemo(
    () => JSON.parse(timesSignature),
    [timesSignature],
  );
  const nextRowIdRef = useRef(authoritativeTimes.length);
  const [rows, setRows] = useState(() =>
    authoritativeTimes.map((time, index) => ({
      id: `time-${index}`,
      value: time,
    })),
  );
  const [validationMessage, setValidationMessage] = useState(null);
  const [focusRowId, setFocusRowId] = useState(null);
  const canceledBlurRef = useRef(new Set());
  const inputRefs = useRef(new Map());
  const rowValues = rows.map((row) => row.value);
  const rowsAreValid = areValidTimes(rowValues);
  const nextTime = rowsAreValid ? getNextTime(rowValues) : null;

  useEffect(() => {
    setRows((current) => {
      if (
        current.length === authoritativeTimes.length &&
        current.every((row, index) => row.value === authoritativeTimes[index])
      ) {
        return current;
      }
      return reconcileTimeRows(current, authoritativeTimes, (time) => ({
        id: `time-${nextRowIdRef.current++}`,
        value: time,
      }));
    });
    setValidationMessage(null);
  }, [authoritativeTimes]);

  useEffect(() => {
    if (focusRowId === null) {
      return;
    }
    const input = inputRefs.current.get(focusRowId);
    if (input) {
      input.focus();
      setFocusRowId(null);
    }
  }, [focusRowId, rows]);

  const restoreRows = () => {
    setRows(
      authoritativeTimes.map((time) => ({
        id: `time-${nextRowIdRef.current++}`,
        value: time,
      })),
    );
    setValidationMessage(null);
    setFocusRowId(null);
  };

  const updateRow = (id, value) => {
    const next = rows.map((row) => (row.id === id ? { ...row, value } : row));
    setRows(next);
    setValidationMessage(
      getTimesValidationMessage(next.map((row) => row.value)),
    );
  };

  const commitRows = (rowId) => {
    if (canceledBlurRef.current.delete(rowId)) {
      return;
    }
    const nextTimes = rows.map((row) => row.value);
    const nextValidationMessage = getTimesValidationMessage(nextTimes);
    setValidationMessage(nextValidationMessage);
    if (nextValidationMessage) {
      return;
    }
    if (nextTimes.some((time, index) => time !== authoritativeTimes[index])) {
      saveDraft(() => onValueChange(nextTimes), restoreRows);
    }
  };

  return (
    <div className="w-full min-w-0 space-y-2 sm:w-52">
      {rows.map((row, index) => (
        <div key={row.id} className="flex min-w-0 items-center gap-1.5">
          <Input
            ref={(node) => {
              if (node) {
                inputRefs.current.set(row.id, node);
              } else {
                inputRefs.current.delete(row.id);
              }
            }}
            type="time"
            aria-label={`Random cursor time ${index + 1}`}
            aria-invalid={validationMessage ? "true" : undefined}
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
                updateRow(row.id, authoritativeTimes[index] ?? "");
                setValidationMessage(null);
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
              const nextRows = rows.filter(
                (candidate) => candidate.id !== row.id,
              );
              const nextTimes = nextRows.map((candidate) => candidate.value);
              setRows(nextRows);
              setValidationMessage(null);
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
      {validationMessage ? (
        <p role="alert" className="text-body-sm text-destructive">
          {validationMessage}
        </p>
      ) : null}
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
          const nextRow = {
            id: `time-${nextRowIdRef.current++}`,
            value: nextTime,
          };
          const nextRows = [...rows, nextRow];
          const nextTimes = nextRows.map((row) => row.value);
          setRows(nextRows);
          setFocusRowId(nextRow.id);
          saveDraft(() => onValueChange(nextTimes), restoreRows);
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
  cursorOperationBusy,
  saving,
  canRandomize,
  canScheduleRandomization,
  scheduleUnavailableMessage,
  randomizationAvailable,
  randomizationPoolSize,
  systemAppearance,
  preferencesAvailable,
  preferencesError,
  preferencesErrorMessage,
  preferencesRetrying,
  onRetryPreferences,
  themeError,
  feedback,
}) {
  const [dataOperation, setDataOperation] = useState(null);
  const [dataFeedback, setDataFeedback] = useState(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
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
  const settingsDisabled = !preferencesAvailable || Boolean(dataOperation);
  const automaticRandomizationEnabled = randomization.automaticEnabled === true;
  const displayedPreferenceError = preferencesError
    ? preferencesErrorMessage
    : preferenceError?.message;
  const emptyPoolMessage =
    preferencesAvailable &&
    randomizationAvailable &&
    randomizationPoolSize === 0
      ? `No ${systemAppearance}-mode cursors match these settings.`
      : null;
  const dataActionsDisabled = Boolean(
    dataOperation || cursorOperationBusy || saving,
  );

  const runDataOperation = async (operation, callback, successMessage) => {
    setDataOperation(operation);
    setDataFeedback(null);
    try {
      const result = await callback();
      if (!result?.canceled) {
        setDataFeedback({ type: "success", message: successMessage });
      }
      return result;
    } catch (error) {
      setDataFeedback({
        type: "error",
        message: error?.message || "The data operation failed.",
      });
      return null;
    } finally {
      setDataOperation(null);
    }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="titlebar-drag flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4 sm:px-6">
        <SheetTitle className="text-title-md">Settings</SheetTitle>
        {saving ? (
          <span
            role="status"
            className="ml-auto text-body-sm text-muted-foreground"
          >
            Saving…
          </span>
        ) : null}
        <SheetClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close settings"
            className={cn(
              "titlebar-no-drag -mr-1 shrink-0",
              !saving && "ml-auto",
            )}
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              strokeWidth={2}
              aria-hidden="true"
            />
          </Button>
        </SheetClose>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6">
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
            <SettingsSection
              title="General"
              action={
                <AppearanceModeSelector
                  value={appearanceMode}
                  onValueChange={onAppearanceModeChange}
                />
              }
            >
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
                          Runs while Cursor Atelier is open or remains in the
                          background.
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

              {!isLinux && (
                <Field orientation="responsive">
                  <FieldContent>
                    <p className="text-title-md text-foreground">App Icon</p>
                  </FieldContent>
                  <p className="max-w-md text-body-sm text-muted-foreground sm:text-right">
                    Follows System Settings → Appearance → Icon &amp; widget
                    style → Dark → Auto
                  </p>
                </Field>
              )}

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="startup-run-in-background">
                    Run in Background at Startup
                  </FieldLabel>
                </FieldContent>
                <Switch
                  id="startup-run-in-background"
                  checked={preferences?.startup?.runInBackground === true}
                  disabled={settingsDisabled}
                  onCheckedChange={(runInBackground) =>
                    onChange({ startup: { runInBackground } })
                  }
                />
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="menu-bar-visible">
                    {isLinux ? "Show in System Tray" : "Show in Menu Bar"}
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

            <SettingsSection
              title="Randomization"
              action={
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    settingsDisabled ||
                    !canRandomize ||
                    cursorOperationBusy ||
                    saving ||
                    randomizing ||
                    (randomization.source === "family" && !randomization.family)
                  }
                  onClick={onRandomize}
                >
                  {randomizing ? "Randomizing…" : "Randomize Now"}
                </Button>
              }
            >
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="randomization-automatic-enabled">
                    Randomize Automatically
                  </FieldLabel>
                </FieldContent>
                <Switch
                  id="randomization-automatic-enabled"
                  checked={automaticRandomizationEnabled}
                  disabled={
                    settingsDisabled ||
                    (!automaticRandomizationEnabled &&
                      !canScheduleRandomization)
                  }
                  onCheckedChange={(automaticEnabled) =>
                    onChange({ randomization: { automaticEnabled } })
                  }
                />
              </Field>

              {feedbackMessage || emptyPoolMessage ? (
                <p
                  role={
                    randomizationFeedback?.type === "error" ? "alert" : "status"
                  }
                  className={cn(
                    "min-w-0 text-body-sm text-muted-foreground",
                    randomizationFeedback?.type === "error" &&
                      "text-destructive",
                  )}
                >
                  {feedbackMessage ?? emptyPoolMessage}
                </p>
              ) : null}

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
                  value={schedule.mode ?? "launch"}
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
              {scheduleUnavailableMessage ? (
                <p className="text-body-sm text-muted-foreground">
                  {scheduleUnavailableMessage}
                </p>
              ) : null}
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

            <SettingsSection title="Data">
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Export Data</FieldLabel>
                </FieldContent>
                <Button
                  type="button"
                  variant="outline"
                  disabled={dataActionsDisabled}
                  onClick={() =>
                    void runDataOperation(
                      "export",
                      () => window.electronAPI.exportAppData(),
                      "Data exported.",
                    )
                  }
                >
                  {dataOperation === "export" ? "Exporting…" : "Export…"}
                </Button>
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Import Data</FieldLabel>
                </FieldContent>
                <Button
                  type="button"
                  variant="outline"
                  disabled={dataActionsDisabled}
                  onClick={() =>
                    void runDataOperation(
                      "import",
                      () => window.electronAPI.importAppData(),
                      "Data imported. System cursor remains active.",
                    )
                  }
                >
                  {dataOperation === "import" ? "Importing…" : "Import…"}
                </Button>
              </Field>

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Full Reset</FieldLabel>
                </FieldContent>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={dataActionsDisabled}
                  onClick={() => setResetDialogOpen(true)}
                >
                  {dataOperation === "reset" ? "Resetting…" : "Reset…"}
                </Button>
              </Field>

              {dataFeedback ? (
                <p
                  role={dataFeedback.type === "error" ? "alert" : "status"}
                  className={cn(
                    "select-text text-body-sm text-muted-foreground",
                    dataFeedback.type === "error" && "text-destructive",
                  )}
                >
                  {dataFeedback.message}
                </p>
              ) : null}
            </SettingsSection>
          </div>
        </div>
      </div>

      <AlertDialog
        open={resetDialogOpen}
        onOpenChange={(open) => {
          if (dataOperation !== "reset") {
            setResetDialogOpen(open);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset Cursor Atelier?</AlertDialogTitle>
            <AlertDialogDescription>
              This restores the Apple cursor and resets all cursor packs and
              settings. Prior data is moved to Trash.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dataOperation === "reset"}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={dataOperation === "reset"}
              onClick={(event) => {
                event.preventDefault();
                void runDataOperation(
                  "reset",
                  () => window.electronAPI.resetAppData(),
                  "Data reset.",
                ).then((result) => {
                  if (!result?.reset) {
                    setResetDialogOpen(false);
                  }
                });
              }}
            >
              Reset All Data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
