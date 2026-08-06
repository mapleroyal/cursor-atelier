import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CommandIcon,
  Cursor01Icon,
  Delete02Icon,
  FileImportIcon,
  InformationCircleIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";

import { AppearanceModeSelector } from "@/components/appearance-mode-selector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import * as catalog from "@/lib/cursor-catalog";
import {
  applyCursorTheme,
  getAutomaticSelectionId,
  getPackRailNavigationIndex,
  getSelectedStatusVariant,
  getStatusVariant,
  isRestoreAvailable,
  isPackVerifiedActive,
  isStatusQueryUnavailable,
  isStatusVerifiedActive,
  isStatusVerifiedRestored,
  importCursorPack,
  matchesCursorPack,
  openLoginItemsSettings,
  resolvePackQuerySource,
  restoreCursors,
} from "@/lib/cursor-ui";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";

const DEFAULT_ROLES = ["default", "text", "pointer", "wait", "progress"];

const FALLBACK_PACK = {
  id: "oreo-white",
  family: "Oreo",
  name: "White",
  variant: "White",
  author: "Oreo Cursor",
  license: "GPL-2.0",
  cursorCount: DEFAULT_ROLES.length,
  roles: DEFAULT_ROLES,
  status: "available",
  available: true,
  canApply: true,
  nativeThemeId: "OreoWhite",
};

const ROLE_LABELS = {
  default: "Arrow",
  arrow: "Arrow",
  pointer: "Link",
  text: "Text",
  wait: "Wait",
  progress: "Progress",
  "not-allowed": "Not allowed",
  "no-drop": "No drop",
  "col-resize": "Column resize",
  "row-resize": "Row resize",
  "dnd-move": "Drag",
  right_ptr: "Right arrow",
  "com.apple.coregraphics.Arrow": "Arrow",
  "com.apple.coregraphics.IBeam": "Text",
  "com.apple.coregraphics.Wait": "Wait",
};

const MAC_ROLE_LABELS = {
  "com.apple.coregraphics.Arrow": "Arrow",
  "com.apple.coregraphics.ArrowS": "Alternate arrow",
  "com.apple.coregraphics.ArrowCtx": "Context menu",
  "com.apple.coregraphics.IBeam": "Text",
  "com.apple.coregraphics.IBeamS": "Alternate text",
  "com.apple.coregraphics.IBeamXOR": "Contrast text",
  "com.apple.coregraphics.Alias": "Alias",
  "com.apple.coregraphics.Copy": "Copy",
  "com.apple.coregraphics.Empty": "Hidden",
  "com.apple.coregraphics.Move": "Move",
  "com.apple.coregraphics.Wait": "Wait",
  "com.apple.cursor.2": "Drag link",
  "com.apple.cursor.3": "Not allowed",
  "com.apple.cursor.4": "Progress",
  "com.apple.cursor.5": "Drag copy",
  "com.apple.cursor.7": "Crosshair",
  "com.apple.cursor.8": "T-cross",
  "com.apple.cursor.11": "Drag",
  "com.apple.cursor.12": "Open hand",
  "com.apple.cursor.13": "Link",
  "com.apple.cursor.17": "Resize left",
  "com.apple.cursor.18": "Resize right",
  "com.apple.cursor.19": "Resize horizontally",
  "com.apple.cursor.20": "Precision select",
  "com.apple.cursor.21": "Resize up",
  "com.apple.cursor.22": "Resize down",
  "com.apple.cursor.23": "Resize vertically",
  "com.apple.cursor.24": "Context menu alternate",
  "com.apple.cursor.25": "Poof",
  "com.apple.cursor.26": "Vertical text",
  "com.apple.cursor.27": "Resize east",
  "com.apple.cursor.28": "Resize east/west",
  "com.apple.cursor.29": "Resize northeast",
  "com.apple.cursor.30": "Resize northeast/southwest",
  "com.apple.cursor.31": "Resize north",
  "com.apple.cursor.32": "Resize north/south",
  "com.apple.cursor.33": "Resize northwest",
  "com.apple.cursor.34": "Resize northwest/southeast",
  "com.apple.cursor.35": "Resize southeast",
  "com.apple.cursor.36": "Resize south",
  "com.apple.cursor.37": "Resize southwest",
  "com.apple.cursor.38": "Resize west",
  "com.apple.cursor.39": "Move alternate",
  "com.apple.cursor.40": "Help",
  "com.apple.cursor.41": "Cell",
  "com.apple.cursor.42": "Zoom in",
  "com.apple.cursor.43": "Zoom out",
};

function formatRoleName(value) {
  const raw = String(value ?? "Cursor");
  if (ROLE_LABELS[raw]) {
    return ROLE_LABELS[raw];
  }

  return raw
    .replace(/^com\.apple\.(?:coregraphics|cursor)\./, "Cursor ")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatAnimationDuration(frameCount, frameDuration) {
  const seconds = Number(frameCount) * Number(frameDuration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  if (seconds < 1) {
    return `${Math.round(seconds * 1000)} ms`;
  }
  return `${Number(seconds.toFixed(seconds < 10 ? 2 : 1))} s`;
}

function previewSource(value) {
  if (typeof catalog.normalizePreviewSource === "function") {
    return catalog.normalizePreviewSource(value);
  }
  if (typeof value === "string" && value) {
    return value;
  }
  return value?.src ?? value?.url ?? null;
}

function normaliseRole(role, index) {
  if (typeof role === "string") {
    return {
      id: role,
      name: formatRoleName(role),
      src: null,
      frameCount: 1,
      frameDuration: null,
      fallback: false,
    };
  }

  const key = String(
    role?.macIdentifier ?? role?.role ?? role?.name ?? `cursor-${index}`,
  );
  return {
    ...role,
    id: key,
    name:
      MAC_ROLE_LABELS[key] ?? formatRoleName(role?.name ?? role?.role ?? key),
    src: previewSource(role),
    frameCount: Number.isFinite(Number(role?.frameCount))
      ? Number(role.frameCount)
      : 1,
    frameDuration: Number.isFinite(Number(role?.frameDuration))
      ? Number(role.frameDuration)
      : null,
    fallback: Boolean(role?.fallback),
  };
}

function normalisePack(pack = {}) {
  const id = String(
    pack.id ?? pack.nativeThemeId ?? pack.name ?? "cursor-pack",
  );
  const family = String(pack.family ?? pack.collection ?? "Cursor pack");
  const variant = String(pack.variant ?? pack.name ?? family);
  const rawRoles =
    Array.isArray(pack.rolePreviews) && pack.rolePreviews.length
      ? pack.rolePreviews
      : (pack.roles ?? pack.cursorRoles ?? DEFAULT_ROLES);
  const roles = Array.isArray(rawRoles)
    ? rawRoles.map(normaliseRole)
    : DEFAULT_ROLES.map(normaliseRole);
  const available = Boolean(
    pack.resourceAvailable ??
    pack.isAvailable ??
    pack.available ??
    pack.nativeThemeId,
  );
  const canApply = Boolean(pack.canApply ?? available);
  const exactRoleCount =
    Array.isArray(pack.rolePreviews) && pack.rolePreviews.length
      ? pack.rolePreviews.length
      : roles.length;

  return {
    ...pack,
    id,
    family,
    variant,
    name: String(pack.name ?? variant),
    author: pack.author ?? "",
    license: pack.license ?? "",
    sourceUrl: pack.sourceUrl ?? pack.url ?? "",
    roles,
    roleCount: exactRoleCount,
    cursorCount: Number.isFinite(Number(pack.cursorCount))
      ? Number(pack.cursorCount)
      : exactRoleCount,
    status: pack.status ?? (available ? "available" : "unavailable"),
    available,
    canApply,
    nativeThemeId: pack.nativeThemeId ?? id,
    preview:
      previewSource(pack.preview) ??
      roles.find(
        (role) =>
          role.role === "default" ||
          role.role === "arrow" ||
          role.macIdentifier === "com.apple.coregraphics.Arrow",
      )?.src ??
      null,
  };
}

function getCatalogue() {
  const source = Array.isArray(catalog.CURSOR_CATALOG)
    ? catalog.CURSOR_CATALOG
    : Array.isArray(catalog.CURSOR_PACKS)
      ? catalog.CURSOR_PACKS
      : [];

  return (source.length ? source : [FALLBACK_PACK]).map(normalisePack);
}

async function getNativeStatus() {
  const method = window.electronAPI?.getCursorStatus;
  if (typeof method !== "function") {
    return {
      available: false,
      bridgeAvailable: false,
      previewMode: true,
      reason: "Cursor engine unavailable",
      selectedVariantId: null,
      effectiveVariantId: null,
      effectiveApplied: false,
    };
  }
  return method();
}

async function getNativeThemes() {
  const listThemes = window.electronAPI?.listCursorThemes;
  if (typeof listThemes !== "function") {
    return [];
  }
  const result = await listThemes();
  return Array.isArray(result) ? result : [];
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error.message === "string") {
    return error.message;
  }
  return "The cursor engine could not complete that operation.";
}

function AppearancePicker() {
  const themeMode = useAppStore((state) => state.themeMode);
  const setThemeMode = useAppStore((state) => state.setThemeMode);

  return (
    <AppearanceModeSelector value={themeMode} onValueChange={setThemeMode} />
  );
}

function PackPreview({ pack, active = false, size = "md", className }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-2xl bg-muted/70 text-muted-foreground",
        size === "lg" ? "size-11" : "size-8",
        active && "bg-primary/10 text-primary",
        className,
      )}
      title={pack.preview ? undefined : "Preview unavailable"}
    >
      {pack.preview ? (
        <img
          src={pack.preview}
          alt=""
          className={cn("object-contain", size === "lg" ? "size-8" : "size-6")}
        />
      ) : (
        <HugeiconsIcon
          icon={Cursor01Icon}
          strokeWidth={1.7}
          className={size === "lg" ? "size-5" : "size-4"}
        />
      )}
    </span>
  );
}

function PackRail({
  packs,
  selectedId,
  effectiveId,
  verifiedActive,
  engineAvailable,
  search,
  onSearch,
  onSelect,
  onClearSearch,
  loadError,
  onClose,
  className,
}) {
  const listboxId = useId();
  const optionRefs = useRef(new Map());
  const groups = useMemo(() => {
    const grouped = new Map();
    for (const pack of packs) {
      if (!grouped.has(pack.family)) {
        grouped.set(pack.family, []);
      }
      grouped.get(pack.family).push(pack);
    }
    return [...grouped.entries()];
  }, [packs]);
  const rovingId = packs.some((pack) => pack.id === selectedId)
    ? selectedId
    : packs[0]?.id;

  const handleOptionKeyDown = useCallback(
    (event, packId) => {
      const currentIndex = packs.findIndex((pack) => pack.id === packId);
      const nextIndex = getPackRailNavigationIndex(
        event.key,
        currentIndex,
        packs.length,
      );
      if (nextIndex === null) {
        return;
      }

      event.preventDefault();
      const nextPack = packs[nextIndex];
      if (!nextPack) {
        return;
      }
      if (nextPack.id !== packId) {
        onSelect(nextPack.id);
      }
      optionRefs.current.get(nextPack.id)?.focus({ preventScroll: true });
      optionRefs.current.get(nextPack.id)?.scrollIntoView({ block: "nearest" });
    },
    [onSelect, packs],
  );

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        className,
      )}
    >
      <div className="shrink-0 px-3 pt-3 pb-2.5 sm:px-4 sm:pt-4">
        <div className="mb-3 flex h-7 min-w-0 items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate text-title-md">Cursor packs</h2>
            <span className="type-numeric text-body-sm text-muted-foreground">
              {packs.length}
            </span>
          </div>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close cursor packs"
              className="-mr-1"
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                strokeWidth={2}
                aria-hidden="true"
              />
            </Button>
          ) : (
            <span className="flex shrink-0 items-center gap-1.5 text-label-md text-muted-foreground">
              <span
                className={cn(
                  "size-1.5 rounded-full bg-muted-foreground/40",
                  verifiedActive && "bg-primary",
                )}
              />
              {!engineAvailable
                ? "Unavailable"
                : verifiedActive
                  ? "Active"
                  : "Off"}
            </span>
          )}
        </div>

        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            strokeWidth={2}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search"
            aria-label="Search cursor packs"
            className="h-8 border-transparent bg-muted/65 pl-8 pr-8 shadow-none focus-visible:bg-background"
          />
          {search ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onClearSearch}
              aria-label="Clear search"
              className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                strokeWidth={2}
                aria-hidden="true"
              />
            </Button>
          ) : null}
        </div>
      </div>

      <div
        data-testid="pack-rail-scroll"
        aria-label={loadError ? undefined : "Cursor packs"}
        role={loadError ? undefined : "listbox"}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pb-3 sm:px-3"
      >
        {loadError ? (
          <p className="px-3 py-8 text-center text-body-sm text-muted-foreground">
            Unavailable
          </p>
        ) : groups.length ? (
          groups.map(([family, familyPacks], groupIndex) => {
            const familyId = `${listboxId}-family-${groupIndex}`;
            return (
              <section
                key={family}
                className="mb-3 min-w-0 last:mb-0"
                role="group"
                aria-labelledby={familyId}
              >
                <h3
                  id={familyId}
                  className="truncate px-2.5 pt-2 pb-1 text-label-sm tracking-[0.02em] text-muted-foreground"
                >
                  {family}
                </h3>
                <div className="min-w-0 space-y-0.5">
                  {familyPacks.map((pack) => {
                    const selected = pack.id === selectedId;
                    const active =
                      verifiedActive && matchesCursorPack(pack, effectiveId);
                    const canApply = engineAvailable && pack.canApply;

                    return (
                      <button
                        type="button"
                        key={pack.id}
                        ref={(node) => {
                          if (node) {
                            optionRefs.current.set(pack.id, node);
                          } else {
                            optionRefs.current.delete(pack.id);
                          }
                        }}
                        onClick={() => {
                          onSelect(pack.id);
                          onClose?.();
                        }}
                        onKeyDown={(event) =>
                          handleOptionKeyDown(event, pack.id)
                        }
                        className={cn(
                          "group relative flex w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-2xl px-2 py-2 text-left outline-none transition-colors before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-transparent focus-visible:ring-2 focus-visible:ring-ring/60",
                          selected
                            ? "bg-accent text-accent-foreground before:bg-primary"
                            : "hover:bg-muted/60",
                          !canApply && "opacity-60",
                        )}
                        aria-selected={selected}
                        aria-label={`${pack.family} ${pack.variant}${active ? ", active" : ""}${canApply ? "" : ", unavailable"}`}
                        role="option"
                        tabIndex={pack.id === rovingId ? 0 : -1}
                      >
                        <PackPreview pack={pack} active={active} />
                        <span className="min-w-0 flex-1 overflow-hidden">
                          <span className="block truncate text-title-md">
                            {pack.variant}
                          </span>
                        </span>
                        {active ? (
                          <HugeiconsIcon
                            icon={CheckmarkCircle02Icon}
                            strokeWidth={2.2}
                            className="size-4 shrink-0 text-primary"
                            aria-hidden="true"
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })
        ) : (
          <p className="px-3 py-8 text-center text-body-sm text-muted-foreground">
            No matches
          </p>
        )}
      </div>
    </div>
  );
}

function CursorRolePreview({ role }) {
  const cycleDuration = formatAnimationDuration(
    role.frameCount,
    role.frameDuration,
  );
  const animation =
    role.frameCount > 1
      ? `${role.frameCount} frames${cycleDuration ? ` · ${cycleDuration}` : ""}`
      : null;

  return (
    <figure className="group min-w-0">
      <div className="flex h-20 items-center justify-center rounded-3xl bg-muted/45 transition-colors group-hover:bg-muted/70">
        <img
          src={role.src}
          alt=""
          loading="lazy"
          className="size-12 object-contain"
        />
      </div>
      <figcaption className="mt-2 min-w-0 px-0.5">
        <span className="block truncate text-body-sm text-foreground/85">
          {role.name}
        </span>
        {animation || role.fallback ? (
          <span className="mt-0.5 block truncate text-[0.65rem] leading-3 text-muted-foreground">
            {animation ?? "Fallback"}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

function PackDetails({
  pack,
  active,
  selectedBySystem,
  operation,
  onApply,
  onRestore,
  onOpenLoginSettings,
  feedback,
  engineAvailable,
  canRestore,
  loginApprovalRequired,
  statusError,
  statusErrorMessage,
  onRetryStatus,
  statusRetrying,
}) {
  const busy = operation !== "idle";
  const canApply = engineAvailable && pack.canApply === true;
  const previewRoles = pack.roles.filter((role) => role.src);
  const count = previewRoles.length || pack.roleCount || pack.cursorCount;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="shrink-0 border-b border-border/60 px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <PackPreview pack={pack} active={active} size="lg" />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-headline-md">{pack.variant}</h1>
                {active ? (
                  <span className="flex shrink-0 items-center gap-1 text-label-md text-primary">
                    <HugeiconsIcon
                      icon={CheckmarkCircle02Icon}
                      strokeWidth={2.2}
                      className="size-3.5"
                      aria-hidden="true"
                    />
                    In use
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 truncate text-body-sm text-muted-foreground">
                {pack.family}
                {pack.author ? ` · ${pack.author}` : ""}
                {!active && selectedBySystem ? " · Selected" : ""}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {pack.sourceUrl ? (
              <Button variant="ghost" size="sm" asChild>
                <a href={pack.sourceUrl} target="_blank" rel="noreferrer">
                  Source
                  <HugeiconsIcon
                    icon={ArrowUpRight01Icon}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                </a>
              </Button>
            ) : null}
            {engineAvailable ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onRestore}
                  disabled={busy || !canRestore}
                >
                  {operation === "restoring" ? "Restoring…" : "Restore"}
                </Button>
                <Button
                  type="button"
                  onClick={onApply}
                  disabled={busy || active || !canApply}
                  size="sm"
                  className="min-w-20"
                  title={canApply ? undefined : "This pack is unavailable"}
                >
                  {operation === "applying"
                    ? "Applying…"
                    : active
                      ? "Applied"
                      : !canApply
                        ? "Unavailable"
                        : "Apply"}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <div
        data-testid="detail-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6 sm:py-6 lg:px-8"
      >
        <div className="mx-auto max-w-5xl">
          {statusError ? (
            <div
              role="alert"
              className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-muted-foreground"
            >
              <span>{statusErrorMessage}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="-my-1"
                onClick={onRetryStatus}
                disabled={statusRetrying}
              >
                {statusRetrying ? "Retrying…" : "Retry"}
              </Button>
            </div>
          ) : null}

          {feedback ? (
            <div
              role={feedback.type === "error" ? "alert" : "status"}
              className={cn(
                "mb-5 flex items-center gap-2 text-body-sm",
                feedback.type === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              <HugeiconsIcon
                icon={
                  feedback.type === "error"
                    ? InformationCircleIcon
                    : CheckmarkCircle02Icon
                }
                strokeWidth={2}
                className="size-4 shrink-0"
                aria-hidden="true"
              />
              <span>{feedback.message}</span>
            </div>
          ) : null}

          {loginApprovalRequired ? (
            <div
              role="status"
              className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-muted-foreground"
            >
              <HugeiconsIcon
                icon={InformationCircleIcon}
                strokeWidth={2}
                className="size-4 shrink-0"
                aria-hidden="true"
              />
              <span>Allow Cursor Atelier in Login Items.</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="-my-1"
                onClick={onOpenLoginSettings}
                disabled={busy}
              >
                {operation === "opening-settings"
                  ? "Opening…"
                  : "Open Settings"}
              </Button>
            </div>
          ) : null}

          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="text-title-md">Cursors</h2>
            <span className="type-numeric text-body-sm text-muted-foreground">
              {count} {count === 1 ? "role" : "roles"}
            </span>
          </div>

          {previewRoles.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,112px)] gap-x-4 gap-y-5 sm:grid-cols-[repeat(auto-fill,124px)]">
              {previewRoles.map((role, index) => (
                <CursorRolePreview key={`${role.id}-${index}`} role={role} />
              ))}
            </div>
          ) : (
            <div className="flex min-h-44 items-center justify-center text-body-sm text-muted-foreground">
              Preview unavailable
            </div>
          )}

          <dl className="mt-8 grid gap-x-8 gap-y-3 border-t border-border/60 pt-5 text-body-sm sm:grid-cols-2">
            <div className="flex min-w-0 justify-between gap-4">
              <dt className="text-muted-foreground">Family</dt>
              <dd className="truncate text-right">{pack.family}</dd>
            </div>
            {pack.author ? (
              <div className="flex min-w-0 justify-between gap-4">
                <dt className="text-muted-foreground">Author</dt>
                <dd className="truncate text-right">{pack.author}</dd>
              </div>
            ) : null}
            {pack.license ? (
              <div className="flex min-w-0 justify-between gap-4">
                <dt className="text-muted-foreground">License</dt>
                <dd className="truncate text-right">{pack.license}</dd>
              </div>
            ) : null}
            <div className="flex min-w-0 justify-between gap-4">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="truncate text-right">
                {active
                  ? "Active"
                  : selectedBySystem
                    ? "Selected"
                    : canApply
                      ? "Available"
                      : "Unavailable"}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

function CatalogueFailure({ onRetry, retrying }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background px-6">
      <div
        role="alert"
        className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-body-sm text-muted-foreground"
      >
        <span>Couldn’t load cursor packs.</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-my-1"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
    </section>
  );
}

export function HomeRoute() {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const initialCatalogue = useMemo(getCatalogue, []);
  const [selectedId, setSelectedId] = useState(
    () => initialCatalogue[0]?.id ?? "",
  );
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState("idle");
  const [feedback, setFeedback] = useState(null);
  const [railOpen, setRailOpen] = useState(false);
  const selectionWasChanged = useRef(false);

  const nativeThemesQuery = useQuery({
    queryKey: ["cursor-themes"],
    queryFn: getNativeThemes,
    staleTime: 15_000,
    retry: false,
  });
  const nativeThemeData = nativeThemesQuery.data;
  const nativeThemeQueryError = nativeThemesQuery.isError;
  const nativeThemeQuerySuccess = nativeThemesQuery.isSuccess;

  const packs = useMemo(() => {
    // Main already validates and normalizes every native row against the
    // curated catalogue. Once it returns an authoritative list, merging the
    // static placeholders again creates fake "Default" rows for families
    // whose real resources are all named variants (Bibata, for example).
    // The static catalogue is used only while the authoritative query is still
    // pending. A resolved empty list or initial failure must stay visibly empty
    // instead of pretending the fallback rows represent installed resources.
    const source = resolvePackQuerySource(
      {
        data: nativeThemeData,
        isError: nativeThemeQueryError,
        isSuccess: nativeThemeQuerySuccess,
      },
      initialCatalogue,
    );
    return source.map(normalisePack);
  }, [
    initialCatalogue,
    nativeThemeData,
    nativeThemeQueryError,
    nativeThemeQuerySuccess,
  ]);

  const statusQuery = useQuery({
    queryKey: ["cursor-status"],
    queryFn: getNativeStatus,
    staleTime: 10_000,
    retry: false,
  });

  const effectiveId = getStatusVariant(statusQuery.data);
  const selectedStatusId = getSelectedStatusVariant(statusQuery.data);
  const previewMode = Boolean(statusQuery.data?.previewMode);
  const statusUnavailable = isStatusQueryUnavailable(statusQuery);
  const statusErrorMessage =
    statusQuery.data?.reason ??
    statusQuery.data?.lastError ??
    (statusQuery.error ? getErrorMessage(statusQuery.error) : null) ??
    "Cursor status unavailable.";
  const nativeThemeListAvailable = Boolean(
    Array.isArray(nativeThemeData) && nativeThemeData.length,
  );
  const engineAvailable = Boolean(
    nativeThemeListAvailable &&
    !statusUnavailable &&
    statusQuery.data?.bridgeAvailable &&
    statusQuery.data?.statusAvailable !== false &&
    statusQuery.data?.supported !== false &&
    !previewMode,
  );
  const verifiedActive = isStatusVerifiedActive(statusQuery.data);
  const canRestore = engineAvailable && isRestoreAvailable(statusQuery.data);
  const loginApprovalRequired = Boolean(
    engineAvailable && statusQuery.data?.loginApprovalRequired,
  );
  const catalogueLoadError = Boolean(
    !nativeThemeListAvailable &&
    (nativeThemeQueryError || nativeThemeQuerySuccess),
  );

  const filteredPacks = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return packs;
    }
    const filterCatalog =
      catalog.filterCursorPacks ?? catalog.filterCursorCatalog;
    if (typeof filterCatalog === "function") {
      const result = filterCatalog(packs, query);
      if (Array.isArray(result)) {
        return result.map(normalisePack);
      }
    }
    return packs.filter((pack) =>
      [pack.id, pack.name, pack.variant, pack.family, pack.author]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [packs, search]);

  useEffect(() => {
    if (selectionWasChanged.current) {
      return;
    }
    const nativeSelection = packs.find(
      (pack) =>
        matchesCursorPack(pack, effectiveId) ||
        matchesCursorPack(pack, selectedStatusId),
    );
    if (nativeSelection) {
      setSelectedId(nativeSelection.id);
    }
  }, [effectiveId, packs, selectedStatusId]);

  useEffect(() => {
    const nextSelectedId = getAutomaticSelectionId(filteredPacks, selectedId);
    if (nextSelectedId) {
      setSelectedId(nextSelectedId);
      setFeedback(null);
    }
  }, [filteredPacks, selectedId]);

  useEffect(() => {
    let delayedRefresh;
    const refreshStatus = () => {
      void queryClient.invalidateQueries({ queryKey: ["cursor-status"] });
      window.clearTimeout(delayedRefresh);
      // The login helper intentionally waits briefly after app activation
      // before reapplying. Fetch once more after that bounded delay so the
      // active marker cannot remain stale until the next focus event.
      delayedRefresh = window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["cursor-status"] });
      }, 400);
    };
    window.addEventListener("focus", refreshStatus);
    return () => {
      window.removeEventListener("focus", refreshStatus);
      window.clearTimeout(delayedRefresh);
    };
  }, [queryClient]);

  const selectedPack = useMemo(
    () =>
      packs.find((pack) => pack.id === selectedId) ??
      filteredPacks[0] ??
      packs[0] ??
      null,
    [filteredPacks, packs, selectedId],
  );

  const handleSelect = useCallback((id) => {
    selectionWasChanged.current = true;
    setSelectedId(id);
    setFeedback(null);
  }, []);

  const refreshStatus = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["cursor-status"] });
    return queryClient.fetchQuery({
      queryKey: ["cursor-status"],
      queryFn: getNativeStatus,
    });
  }, [queryClient]);

  const handleApply = useCallback(async () => {
    if (!engineAvailable || !selectedPack || selectedPack.canApply !== true) {
      return;
    }
    setFeedback(null);
    setOperation("applying");
    try {
      await applyCursorTheme(selectedPack.nativeThemeId ?? selectedPack.id);
      const nextStatus = await refreshStatus();
      if (!isPackVerifiedActive(nextStatus, selectedPack)) {
        throw new Error(
          `${selectedPack.variant} could not be verified as active.`,
        );
      }
      setFeedback({
        type: "success",
        message: `${selectedPack.variant} is active.`,
      });
    } catch (error) {
      try {
        await refreshStatus();
      } catch {
        // Preserve the operation error; the query retains its previous state.
      }
      setFeedback({ type: "error", message: getErrorMessage(error) });
    } finally {
      setOperation("idle");
    }
  }, [engineAvailable, refreshStatus, selectedPack]);

  const handleRestore = useCallback(async () => {
    setFeedback(null);
    setOperation("restoring");
    try {
      await restoreCursors();
      const nextStatus = await refreshStatus();
      if (!isStatusVerifiedRestored(nextStatus)) {
        throw new Error("The macOS cursor restore could not be verified.");
      }
      setFeedback({
        type: "success",
        message: "macOS cursor restored.",
      });
    } catch (error) {
      try {
        await refreshStatus();
      } catch {
        // Preserve the operation error; the query retains its previous state.
      }
      setFeedback({ type: "error", message: getErrorMessage(error) });
    } finally {
      setOperation("idle");
    }
  }, [refreshStatus]);

  const handleImport = useCallback(async () => {
    setFeedback(null);
    setOperation("importing");
    try {
      const result = await importCursorPack();
      if (result?.canceled) {
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ["cursor-themes"] });
      const nextThemes = await queryClient.fetchQuery({
        queryKey: ["cursor-themes"],
        queryFn: getNativeThemes,
      });
      const identifiers = new Set(
        Array.isArray(result?.identifiers)
          ? result.identifiers.map(String)
          : [],
      );
      const importedPack = nextThemes
        .map(normalisePack)
        .find(
          (pack) =>
            identifiers.has(pack.nativeThemeId) || identifiers.has(pack.id),
        );
      if (importedPack) {
        selectionWasChanged.current = true;
        setSearch("");
        setSelectedId(importedPack.id);
      }

      const importedCount = Number(result?.importedCount ?? identifiers.size);
      const duplicateCount = Number(result?.duplicateCount ?? 0);
      const warning = Array.isArray(result?.warnings)
        ? result.warnings[0]
        : null;
      const message = importedCount
        ? `Imported ${importedCount} cursor ${importedCount === 1 ? "pack" : "packs"}.`
        : duplicateCount
          ? "That cursor pack is already imported."
          : "Cursor import completed.";
      setFeedback({
        type: "success",
        message: warning ? `${message} ${warning}` : message,
      });
    } catch (error) {
      setFeedback({ type: "error", message: getErrorMessage(error) });
    } finally {
      setOperation("idle");
    }
  }, [queryClient]);

  const handleOpenLoginSettings = useCallback(async () => {
    setFeedback(null);
    setOperation("opening-settings");
    try {
      await openLoginItemsSettings();
    } catch (error) {
      setFeedback({ type: "error", message: getErrorMessage(error) });
    } finally {
      setOperation("idle");
    }
  }, []);

  const active =
    selectedPack &&
    verifiedActive &&
    matchesCursorPack(selectedPack, effectiveId);
  const selectedBySystem =
    selectedPack && matchesCursorPack(selectedPack, selectedStatusId);

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background">
      <header className="titlebar-drag flex h-14 shrink-0 items-center justify-between border-b border-border/60 pr-3 pl-[78px] sm:pr-4">
        <div className="hidden min-w-0 items-center gap-2 sm:flex">
          <HugeiconsIcon
            icon={Cursor01Icon}
            strokeWidth={1.9}
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <h1 className="truncate text-title-md">Cursor Atelier</h1>
        </div>

        <div className="titlebar-no-drag flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleImport}
            disabled={operation !== "idle"}
          >
            <HugeiconsIcon
              icon={FileImportIcon}
              strokeWidth={2}
              aria-hidden="true"
            />
            {operation === "importing" ? "Importing…" : "Import"}
          </Button>
          {isMobile ? (
            <Sheet open={railOpen} onOpenChange={setRailOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="sm">
                  <HugeiconsIcon
                    icon={CommandIcon}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  Packs
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                showCloseButton={false}
                className="max-w-[340px] overflow-hidden p-0"
                style={{ width: "min(88vw, 340px)" }}
              >
                <SheetHeader className="sr-only">
                  <SheetTitle>Choose a cursor pack</SheetTitle>
                  <SheetDescription>Choose a cursor pack.</SheetDescription>
                </SheetHeader>
                <PackRail
                  packs={filteredPacks}
                  selectedId={selectedId}
                  effectiveId={effectiveId}
                  verifiedActive={verifiedActive}
                  engineAvailable={engineAvailable}
                  search={search}
                  onSearch={setSearch}
                  onSelect={handleSelect}
                  onClearSearch={() => setSearch("")}
                  loadError={catalogueLoadError}
                  onClose={() => setRailOpen(false)}
                />
              </SheetContent>
            </Sheet>
          ) : null}
          <AppearancePicker />
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <aside className="hidden min-h-0 min-w-0 w-[276px] shrink-0 overflow-hidden border-r border-border/60 bg-sidebar/45 md:flex lg:w-[296px]">
          <PackRail
            packs={filteredPacks}
            selectedId={selectedId}
            effectiveId={effectiveId}
            verifiedActive={verifiedActive}
            engineAvailable={engineAvailable}
            search={search}
            onSearch={setSearch}
            onSelect={handleSelect}
            onClearSearch={() => setSearch("")}
            loadError={catalogueLoadError}
          />
        </aside>
        {selectedPack ? (
          <PackDetails
            pack={selectedPack}
            active={active}
            selectedBySystem={selectedBySystem}
            operation={operation}
            onApply={handleApply}
            onRestore={handleRestore}
            onOpenLoginSettings={handleOpenLoginSettings}
            feedback={feedback}
            engineAvailable={engineAvailable}
            canRestore={canRestore}
            loginApprovalRequired={loginApprovalRequired}
            statusError={statusUnavailable}
            statusErrorMessage={statusErrorMessage}
            onRetryStatus={() => void statusQuery.refetch()}
            statusRetrying={statusQuery.isFetching}
          />
        ) : (
          <CatalogueFailure
            onRetry={() => void nativeThemesQuery.refetch()}
            retrying={nativeThemesQuery.isFetching}
          />
        )}
      </div>
    </main>
  );
}
