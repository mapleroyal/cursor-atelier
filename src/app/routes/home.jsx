import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUpRight01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CommandIcon,
  Cursor01Icon,
  Delete01Icon,
  Delete02Icon,
  FavouriteIcon,
  FileImportIcon,
  FolderEditIcon,
  FolderFavouriteIcon,
  InformationCircleIcon,
  Moon02Icon,
  Search01Icon,
  Settings02Icon,
  Sun02Icon,
} from "@hugeicons/core-free-icons";

import { AppearanceModeSelector } from "@/components/appearance-mode-selector";
import { SettingsScreen } from "@/components/settings-screen";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import * as catalog from "@/lib/cursor-catalog";
import {
  createDefaultCursorPreferences,
  getCursorPreferenceId,
  mergeCursorPreferences,
  normalizeCursorPreferences,
} from "@/lib/cursor-preferences";
import {
  DEFAULT_CURSOR_SIZE_PERCENTAGE,
  MAX_CURSOR_SIZE_PERCENTAGE,
  MIN_CURSOR_SIZE_PERCENTAGE,
  applyCursorTheme,
  assignImportedCursorFamily,
  deleteImportedCursor,
  deleteImportedCursorFamily,
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
  normalizeCursorSizePercentage,
  openLoginItemsSettings,
  resolvePackQuerySource,
  restoreCursors,
  setCursorThemeSize,
} from "@/lib/cursor-ui";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";

const DEFAULT_ROLES = ["default", "text", "pointer", "wait", "progress"];
const CONTEXT_MENU_DISMISS_MS = 100;

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
    sizePercentage: normalizeCursorSizePercentage(
      pack.sizePercentage ?? pack.SizePercentage,
    ),
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

async function getNativePreferences() {
  const getPreferences = window.electronAPI?.getCursorPreferences;
  if (typeof getPreferences !== "function") {
    return createDefaultCursorPreferences();
  }
  return normalizeCursorPreferences(await getPreferences());
}

async function updateNativePreferences(patch) {
  const updatePreferences = window.electronAPI?.updateCursorPreferences;
  if (typeof updatePreferences !== "function") {
    throw new Error("Cursor settings are unavailable in this build.");
  }
  return normalizeCursorPreferences(await updatePreferences(patch));
}

async function randomizeNativeCursor() {
  const randomize = window.electronAPI?.randomizeCursor;
  if (typeof randomize !== "function") {
    throw new Error("Cursor randomization is unavailable in this build.");
  }
  return randomize();
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

function PackContextActions({
  pack,
  favorite,
  appearanceRoles,
  familyNames = [],
  managementDisabled = false,
  onAssignFamily,
  onCreateFamily,
  onDelete,
  onToggleFavorite,
  onToggleAppearanceRole,
  children,
}) {
  const preferenceId = getCursorPreferenceId(pack);
  const roles = Array.isArray(appearanceRoles) ? appearanceRoles : [];
  const canManageImport = pack.imported === true;
  const otherFamilies = familyNames.filter(
    (family) => family.toLocaleLowerCase() !== pack.family.toLocaleLowerCase(),
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => onToggleFavorite(preferenceId, !favorite)}
        >
          <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} />
          {favorite ? "Remove from Favorites" : "Add to Favorites"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem
          checked={roles.includes("light")}
          onCheckedChange={(checked) =>
            onToggleAppearanceRole(preferenceId, "light", checked === true)
          }
        >
          <HugeiconsIcon icon={Sun02Icon} strokeWidth={2} />
          Light mode
        </ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem
          checked={roles.includes("dark")}
          onCheckedChange={(checked) =>
            onToggleAppearanceRole(preferenceId, "dark", checked === true)
          }
        >
          <HugeiconsIcon icon={Moon02Icon} strokeWidth={2} />
          Dark mode
        </ContextMenuCheckboxItem>
        {canManageImport ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={managementDisabled}>
                <HugeiconsIcon icon={FolderEditIcon} strokeWidth={2} />
                Move to family
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-w-72 min-w-48">
                {otherFamilies.map((family) => (
                  <ContextMenuItem
                    key={family}
                    onSelect={() => onAssignFamily?.(pack, family)}
                  >
                    <span className="truncate">{family}</span>
                  </ContextMenuItem>
                ))}
                {otherFamilies.length ? <ContextMenuSeparator /> : null}
                <ContextMenuItem
                  onSelect={() => {
                    window.setTimeout(
                      () => onCreateFamily?.(pack),
                      CONTEXT_MENU_DISMISS_MS,
                    );
                  }}
                >
                  New family…
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              disabled={managementDisabled}
              onSelect={() => {
                window.setTimeout(
                  () => onDelete?.(pack),
                  CONTEXT_MENU_DISMISS_MS,
                );
              }}
            >
              <HugeiconsIcon icon={Delete01Icon} strokeWidth={2} />
              Delete cursor…
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FamilyContextActions({
  family,
  familyPacks = [],
  favorite,
  managementDisabled = false,
  onDelete,
  onToggleFavorite,
  children,
}) {
  const canDelete =
    familyPacks.length > 0 && familyPacks.every((pack) => pack.imported === true);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onToggleFavorite(family, !favorite)}>
          <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} />
          {favorite ? "Remove from Favorites" : "Add to Favorites"}
        </ContextMenuItem>
        {canDelete ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              disabled={managementDisabled}
              onSelect={() => {
                window.setTimeout(
                  () => onDelete?.(family, familyPacks),
                  CONTEXT_MENU_DISMISS_MS,
                );
              }}
            >
              <HugeiconsIcon icon={Delete01Icon} strokeWidth={2} />
              Delete family…
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function PackRailShortcut({
  pack,
  label,
  active,
  favorite,
  appearanceRoles,
  libraryActions,
  onSelect,
  onToggleFavorite,
  onToggleAppearanceRole,
}) {
  return (
    <PackContextActions
      pack={pack}
      favorite={favorite}
      appearanceRoles={appearanceRoles}
      {...libraryActions}
      onToggleFavorite={onToggleFavorite}
      onToggleAppearanceRole={onToggleAppearanceRole}
    >
      <button
        type="button"
        onClick={() => onSelect(pack.id)}
        className="group flex w-full min-w-0 items-center gap-2.5 rounded-2xl px-2 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <PackPreview pack={pack} active={active} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-title-md">{pack.variant}</span>
          <span className="block truncate text-body-sm text-muted-foreground">
            {label ?? pack.family}
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
    </PackContextActions>
  );
}

function PackRail({
  packs,
  allPacks = packs,
  selectedId,
  effectiveId,
  verifiedActive,
  engineAvailable,
  preferences,
  search,
  onSearch,
  onSelect,
  onClearSearch,
  onToggleCursorFavorite,
  onToggleFamilyFavorite,
  onToggleAppearanceRole,
  libraryActions = {},
  loadError,
  onClose,
  className,
}) {
  const optionRefs = useRef(new Map());
  const familyRefs = useRef(new Map());
  const [expandedFamilies, setExpandedFamilies] = useState(() => new Set());
  const searchActive = Boolean(search.trim());
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
  const visiblePacks = useMemo(
    () =>
      groups.flatMap(([family, familyPacks]) =>
        searchActive || expandedFamilies.has(family) ? familyPacks : [],
      ),
    [expandedFamilies, groups, searchActive],
  );
  const rovingId = visiblePacks.some((pack) => pack.id === selectedId)
    ? selectedId
    : visiblePacks[0]?.id;
  const favoriteCursorIds = new Set(preferences.favorites.cursorIds);
  const favoriteFamilies = new Set(preferences.favorites.families);
  const allPacksByFamily = useMemo(() => {
    const result = new Map();
    for (const pack of allPacks) {
      if (!result.has(pack.family)) {
        result.set(pack.family, []);
      }
      result.get(pack.family).push(pack);
    }
    return result;
  }, [allPacks]);
  const familyNames = useMemo(
    () =>
      [...new Set(allPacks.map((pack) => pack.family).filter(Boolean))].sort(
        (left, right) => left.localeCompare(right),
      ),
    [allPacks],
  );
  const packLibraryActions = { ...libraryActions, familyNames };
  const currentPack = verifiedActive
    ? allPacks.find((pack) => matchesCursorPack(pack, effectiveId))
    : null;
  const favoritePacks = allPacks.filter((pack) =>
    favoriteCursorIds.has(getCursorPreferenceId(pack)),
  );
  const hasFavorites = favoritePacks.length > 0 || favoriteFamilies.size > 0;

  const setFamilyExpanded = useCallback((family, expanded) => {
    setExpandedFamilies((current) => {
      const next = new Set(current);
      if (expanded) {
        next.add(family);
      } else {
        next.delete(family);
      }
      return next;
    });
  }, []);

  const revealFavoriteFamily = useCallback(
    (family) => {
      onClearSearch();
      setFamilyExpanded(family, true);
      window.setTimeout(() => {
        familyRefs.current
          .get(family)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 0);
    },
    [onClearSearch, setFamilyExpanded],
  );

  const selectShortcut = useCallback(
    (packId) => {
      onSelect(packId);
      onClose?.();
    },
    [onClose, onSelect],
  );

  const handleOptionKeyDown = useCallback(
    (event, packId) => {
      const currentIndex = visiblePacks.findIndex((pack) => pack.id === packId);
      const nextIndex = getPackRailNavigationIndex(
        event.key,
        currentIndex,
        visiblePacks.length,
      );
      if (nextIndex === null) {
        return;
      }

      event.preventDefault();
      const nextPack = visiblePacks[nextIndex];
      if (!nextPack) {
        return;
      }
      if (nextPack.id !== packId) {
        onSelect(nextPack.id);
      }
      optionRefs.current.get(nextPack.id)?.focus({ preventScroll: true });
      optionRefs.current.get(nextPack.id)?.scrollIntoView({ block: "nearest" });
    },
    [onSelect, visiblePacks],
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
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pb-3 sm:px-3"
      >
        {!loadError && (currentPack || hasFavorites) ? (
          <nav aria-label="Cursor shortcuts" className="pb-2">
            {currentPack ? (
              <div>
                <h3 className="px-2.5 pt-1 pb-0.5 text-label-sm tracking-[0.02em] text-muted-foreground">
                  Current
                </h3>
                <PackRailShortcut
                  pack={currentPack}
                  label={currentPack.family}
                  active
                  favorite={favoriteCursorIds.has(
                    getCursorPreferenceId(currentPack),
                  )}
                  appearanceRoles={
                    preferences.appearance.roles[
                      getCursorPreferenceId(currentPack)
                    ]
                  }
                  libraryActions={packLibraryActions}
                  onSelect={selectShortcut}
                  onToggleFavorite={onToggleCursorFavorite}
                  onToggleAppearanceRole={onToggleAppearanceRole}
                />
              </div>
            ) : null}

            {currentPack && hasFavorites ? (
              <Separator className="mx-2 my-2 w-auto" />
            ) : null}

            {hasFavorites ? (
              <div>
                <h3 className="px-2.5 pt-1 pb-0.5 text-label-sm tracking-[0.02em] text-muted-foreground">
                  Favorites
                </h3>
                <div className="space-y-0.5">
                  {[...favoriteFamilies].map((family) => {
                    const familyActive = currentPack?.family === family;
                    return (
                      <FamilyContextActions
                        key={family}
                        family={family}
                        familyPacks={allPacksByFamily.get(family) ?? []}
                        favorite
                        managementDisabled={libraryActions.managementDisabled}
                        onDelete={libraryActions.onDeleteFamily}
                        onToggleFavorite={onToggleFamilyFavorite}
                      >
                        <button
                          type="button"
                          onClick={() => revealFavoriteFamily(family)}
                          className="flex w-full min-w-0 items-center gap-2.5 rounded-2xl px-2 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-2xl bg-muted/70 text-muted-foreground">
                            <HugeiconsIcon
                              icon={FolderFavouriteIcon}
                              strokeWidth={1.9}
                              className="size-4"
                              aria-hidden="true"
                            />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-title-md">
                            {family}
                          </span>
                          {familyActive ? (
                            <HugeiconsIcon
                              icon={CheckmarkCircle02Icon}
                              strokeWidth={2.2}
                              className="size-4 shrink-0 text-primary"
                              aria-hidden="true"
                            />
                          ) : null}
                        </button>
                      </FamilyContextActions>
                    );
                  })}
                  {favoritePacks.map((pack) => (
                    <PackRailShortcut
                      key={pack.id}
                      pack={pack}
                      active={
                        verifiedActive && matchesCursorPack(pack, effectiveId)
                      }
                      favorite
                      appearanceRoles={
                        preferences.appearance.roles[
                          getCursorPreferenceId(pack)
                        ]
                      }
                      libraryActions={packLibraryActions}
                      onSelect={selectShortcut}
                      onToggleFavorite={onToggleCursorFavorite}
                      onToggleAppearanceRole={onToggleAppearanceRole}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            <Separator className="mx-2 mt-2 w-auto" />
          </nav>
        ) : null}

        {loadError ? (
          <p className="px-3 py-8 text-center text-body-sm text-muted-foreground">
            Unavailable
          </p>
        ) : groups.length ? (
          <nav aria-label="Cursor packs">
            {groups.map(([family, familyPacks]) => {
              const expanded = searchActive || expandedFamilies.has(family);
              const familyActive = familyPacks.some(
                (pack) =>
                  verifiedActive && matchesCursorPack(pack, effectiveId),
              );
              const familyFavorite = favoriteFamilies.has(family);
              return (
                <Collapsible
                  key={family}
                  open={expanded}
                  onOpenChange={(open) => {
                    if (!searchActive) {
                      setFamilyExpanded(family, open);
                    }
                  }}
                  asChild
                >
                  <section
                    ref={(node) => {
                      if (node) {
                        familyRefs.current.set(family, node);
                      } else {
                        familyRefs.current.delete(family);
                      }
                    }}
                    className="mb-1 min-w-0 last:mb-0"
                  >
                    <FamilyContextActions
                      family={family}
                      familyPacks={allPacksByFamily.get(family) ?? []}
                      favorite={familyFavorite}
                      managementDisabled={libraryActions.managementDisabled}
                      onDelete={libraryActions.onDeleteFamily}
                      onToggleFavorite={onToggleFamilyFavorite}
                    >
                      <CollapsibleTrigger asChild>
                        <button
                          type="button"
                          className="group flex w-full min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left text-label-sm tracking-[0.02em] text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                          <HugeiconsIcon
                            icon={ArrowRight01Icon}
                            strokeWidth={2}
                            className={cn(
                              "size-3.5 shrink-0 transition-transform",
                              expanded && "rotate-90",
                            )}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {family}
                          </span>
                          {familyFavorite ? (
                            <HugeiconsIcon
                              icon={FavouriteIcon}
                              strokeWidth={2}
                              className="size-3.5 shrink-0"
                              aria-label="Favorite family"
                            />
                          ) : null}
                          {familyActive && !expanded ? (
                            <HugeiconsIcon
                              icon={CheckmarkCircle02Icon}
                              strokeWidth={2.2}
                              className="size-4 shrink-0 text-primary"
                              aria-label="Contains current cursor"
                            />
                          ) : null}
                          <span className="type-numeric text-[0.65rem] font-normal text-muted-foreground/75">
                            {familyPacks.length}
                          </span>
                        </button>
                      </CollapsibleTrigger>
                    </FamilyContextActions>
                    <CollapsibleContent>
                      <div className="min-w-0 space-y-0.5 pb-1">
                        {familyPacks.map((pack) => {
                          const selected = pack.id === selectedId;
                          const active =
                            verifiedActive &&
                            matchesCursorPack(pack, effectiveId);
                          const canApply =
                            engineAvailable && pack.canApply === true;
                          const preferenceId = getCursorPreferenceId(pack);

                          return (
                            <PackContextActions
                              key={pack.id}
                              pack={pack}
                              favorite={favoriteCursorIds.has(preferenceId)}
                              appearanceRoles={
                                preferences.appearance.roles[preferenceId]
                              }
                              {...packLibraryActions}
                              onToggleFavorite={onToggleCursorFavorite}
                              onToggleAppearanceRole={onToggleAppearanceRole}
                            >
                              <button
                                type="button"
                                ref={(node) => {
                                  if (node) {
                                    optionRefs.current.set(pack.id, node);
                                  } else {
                                    optionRefs.current.delete(pack.id);
                                  }
                                }}
                                onClick={() => selectShortcut(pack.id)}
                                onKeyDown={(event) =>
                                  handleOptionKeyDown(event, pack.id)
                                }
                                className={cn(
                                  "group relative flex w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-2xl px-2 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
                                  selected
                                    ? "bg-accent text-accent-foreground"
                                    : "hover:bg-muted/60",
                                  !canApply && "opacity-60",
                                )}
                                aria-current={selected ? "true" : undefined}
                                aria-label={`${pack.family} ${pack.variant}${active ? ", active" : ""}${canApply ? "" : ", unavailable"}`}
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
                            </PackContextActions>
                          );
                        })}
                      </div>
                    </CollapsibleContent>
                  </section>
                </Collapsible>
              );
            })}
          </nav>
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
  favorite,
  appearanceRoles = [],
  selectedBySystem,
  operation,
  onApply,
  onSizeCommit,
  onToggleFavorite,
  onToggleAppearanceRole,
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
  effectiveSizePercentage,
}) {
  const busy = operation !== "idle";
  const canApply = engineAvailable && pack.canApply === true;
  const [previewSize, setPreviewSize] = useState(pack.sizePercentage);
  useEffect(() => {
    setPreviewSize(pack.sizePercentage);
  }, [pack.id, pack.sizePercentage]);
  const sizeNeedsApply =
    active && pack.sizePercentage !== effectiveSizePercentage;
  const previewRoles = pack.roles.filter((role) => role.src);
  const count = previewRoles.length || pack.roleCount || pack.cursorCount;
  const previewPixels = (32 * previewSize) / 100;

  const commitSize = useCallback(
    (values) => {
      const nextSize = normalizeCursorSizePercentage(
        values?.[0],
        pack.sizePercentage,
      );
      Promise.resolve(onSizeCommit(nextSize)).catch(() => {
        setPreviewSize(pack.sizePercentage);
      });
    },
    [onSizeCommit, pack.sizePercentage],
  );

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

          <TooltipProvider>
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
                    disabled={busy || (active && !sizeNeedsApply) || !canApply}
                    size="sm"
                    className="min-w-20"
                    title={canApply ? undefined : "This pack is unavailable"}
                  >
                    {operation === "applying"
                      ? "Applying…"
                      : active
                        ? sizeNeedsApply
                          ? "Reapply"
                          : "Applied"
                        : !canApply
                          ? "Unavailable"
                          : "Apply"}
                  </Button>
                </>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      favorite ? "Remove from Favorites" : "Add to Favorites"
                    }
                    className={cn(
                      "text-muted-foreground",
                      favorite && "text-rose-500 hover:text-rose-500",
                    )}
                    onClick={onToggleFavorite}
                  >
                    <HugeiconsIcon
                      icon={FavouriteIcon}
                      strokeWidth={2}
                      className={cn("size-4", favorite && "fill-current")}
                      aria-hidden="true"
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {favorite ? "Remove from Favorites" : "Add to Favorites"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-pressed={appearanceRoles.includes("light")}
                    aria-label="Light mode cursor"
                    className={cn(
                      "text-muted-foreground",
                      appearanceRoles.includes("light") && "text-primary",
                    )}
                    onClick={() => onToggleAppearanceRole("light")}
                  >
                    <HugeiconsIcon
                      icon={Sun02Icon}
                      strokeWidth={2}
                      className="size-4"
                      aria-hidden="true"
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Light mode cursor</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-pressed={appearanceRoles.includes("dark")}
                    aria-label="Dark mode cursor"
                    className={cn(
                      "text-muted-foreground",
                      appearanceRoles.includes("dark") && "text-primary",
                    )}
                    onClick={() => onToggleAppearanceRole("dark")}
                  >
                    <HugeiconsIcon
                      icon={Moon02Icon}
                      strokeWidth={2}
                      className="size-4"
                      aria-hidden="true"
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Dark mode cursor</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
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

          <div className="mb-6 grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-5 border-b border-border/60 pb-6">
            <div className="flex size-20 items-center justify-center rounded-xl bg-muted/45">
              {pack.preview ? (
                <img
                  src={pack.preview}
                  alt=""
                  draggable="false"
                  className="object-contain"
                  style={{ width: previewPixels, height: previewPixels }}
                />
              ) : (
                <HugeiconsIcon
                  icon={Cursor01Icon}
                  strokeWidth={1.7}
                  className="text-muted-foreground"
                  style={{ width: previewPixels, height: previewPixels }}
                  aria-hidden="true"
                />
              )}
            </div>
            <div className="min-w-0">
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <span className="text-title-md">Size</span>
                <span className="type-numeric text-body-sm text-muted-foreground">
                  {previewSize}%
                </span>
              </div>
              <Slider
                aria-label={`${pack.variant} cursor size`}
                min={MIN_CURSOR_SIZE_PERCENTAGE}
                max={MAX_CURSOR_SIZE_PERCENTAGE}
                step={5}
                value={[previewSize]}
                onValueChange={(values) =>
                  setPreviewSize(
                    normalizeCursorSizePercentage(
                      values?.[0],
                      DEFAULT_CURSOR_SIZE_PERCENTAGE,
                    ),
                  )
                }
                onValueCommit={commitSize}
                disabled={busy || !canApply}
              />
            </div>
          </div>

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
  const [view, setView] = useState("catalog");
  const [selectedId, setSelectedId] = useState(
    () => initialCatalogue[0]?.id ?? "",
  );
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState("idle");
  const [feedback, setFeedback] = useState(null);
  const [railOpen, setRailOpen] = useState(false);
  const [familyEditor, setFamilyEditor] = useState(null);
  const [familyName, setFamilyName] = useState("");
  const [familyDialogError, setFamilyDialogError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const selectionWasChanged = useRef(false);
  const selectedIdRef = useRef(selectedId);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const preferencesQuery = useQuery({
    queryKey: ["cursor-preferences"],
    queryFn: getNativePreferences,
    staleTime: Infinity,
    retry: false,
  });
  const preferences = useMemo(
    () => normalizeCursorPreferences(preferencesQuery.data),
    [preferencesQuery.data],
  );

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
  const effectiveSizePercentage = normalizeCursorSizePercentage(
    statusQuery.data?.themeSizePercentage,
  );
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

  useEffect(() => {
    const api = window.electronAPI;
    const unsubscribers = [];
    if (typeof api?.onCursorPreferencesChanged === "function") {
      unsubscribers.push(
        api.onCursorPreferencesChanged((nextPreferences) => {
          queryClient.setQueryData(
            ["cursor-preferences"],
            normalizeCursorPreferences(nextPreferences),
          );
        }),
      );
    }
    if (typeof api?.onCursorChanged === "function") {
      unsubscribers.push(
        api.onCursorChanged((event) => {
          if (event?.reason === "renderer-size-preference") {
            void queryClient.invalidateQueries({ queryKey: ["cursor-themes"] });
            return;
          }
          void queryClient.invalidateQueries({ queryKey: ["cursor-status"] });
        }),
      );
    }
    if (typeof api?.onNavigate === "function") {
      unsubscribers.push(
        api.onNavigate((destination) => {
          if (destination === "settings") {
            setView("settings");
            setRailOpen(false);
            setFeedback(null);
          } else if (destination === "catalog") {
            setView("catalog");
          }
        }),
      );
    }

    return () => {
      for (const unsubscribe of unsubscribers) {
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      }
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

  const handlePreferenceChange = useCallback(
    async (patch) => {
      setFeedback(null);
      const previous = normalizeCursorPreferences(
        queryClient.getQueryData(["cursor-preferences"]),
      );
      const optimistic = mergeCursorPreferences(previous, patch);
      queryClient.setQueryData(["cursor-preferences"], optimistic);
      try {
        const updated = await updateNativePreferences(patch);
        queryClient.setQueryData(["cursor-preferences"], updated);
      } catch (error) {
        queryClient.setQueryData(["cursor-preferences"], previous);
        setFeedback({
          scope: "preferences",
          type: "error",
          message: getErrorMessage(error),
        });
      }
    },
    [queryClient],
  );

  const handleToggleCursorFavorite = useCallback(
    (preferenceId, favorite) => {
      if (!preferenceId) {
        return;
      }
      const current = normalizeCursorPreferences(
        queryClient.getQueryData(["cursor-preferences"]),
      );
      const cursorIds = new Set(current.favorites.cursorIds);
      if (favorite) {
        cursorIds.add(preferenceId);
      } else {
        cursorIds.delete(preferenceId);
      }
      void handlePreferenceChange({
        favorites: { cursorIds: [...cursorIds] },
      });
    },
    [handlePreferenceChange, queryClient],
  );

  const handleToggleFamilyFavorite = useCallback(
    (family, favorite) => {
      if (!family) {
        return;
      }
      const current = normalizeCursorPreferences(
        queryClient.getQueryData(["cursor-preferences"]),
      );
      const families = new Set(current.favorites.families);
      if (favorite) {
        families.add(family);
      } else {
        families.delete(family);
      }
      void handlePreferenceChange({
        favorites: { families: [...families] },
      });
    },
    [handlePreferenceChange, queryClient],
  );

  const handleToggleAppearanceRole = useCallback(
    (preferenceId, role, enabled) => {
      if (!preferenceId || (role !== "light" && role !== "dark")) {
        return;
      }
      const current = normalizeCursorPreferences(
        queryClient.getQueryData(["cursor-preferences"]),
      );
      const roles = { ...current.appearance.roles };
      const cursorRoles = new Set(roles[preferenceId] ?? []);
      if (enabled) {
        cursorRoles.add(role);
      } else {
        cursorRoles.delete(role);
      }
      if (cursorRoles.size) {
        roles[preferenceId] = [...cursorRoles];
      } else {
        delete roles[preferenceId];
      }
      void handlePreferenceChange({ appearance: { roles } });
    },
    [handlePreferenceChange, queryClient],
  );

  const refreshStatus = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["cursor-status"] });
    return queryClient.fetchQuery({
      queryKey: ["cursor-status"],
      queryFn: getNativeStatus,
    });
  }, [queryClient]);

  const refreshLibraryQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["cursor-themes"] }),
      queryClient.invalidateQueries({ queryKey: ["cursor-preferences"] }),
      queryClient.invalidateQueries({ queryKey: ["cursor-status"] }),
    ]);
  }, [queryClient]);

  const handleRandomize = useCallback(async () => {
    setFeedback(null);
    setOperation("randomizing");
    try {
      const result = await randomizeNativeCursor();
      const randomizedId =
        result?.cursor?.nativeThemeId ??
        result?.cursor?.id ??
        result?.nativeThemeId ??
        null;
      const randomizedPack = randomizedId
        ? packs.find((pack) => matchesCursorPack(pack, randomizedId))
        : null;
      if (randomizedPack) {
        selectionWasChanged.current = true;
        setSelectedId(randomizedPack.id);
      }
      await refreshStatus();
      setFeedback({
        scope: "randomization",
        type: "success",
        message: randomizedPack
          ? `${randomizedPack.variant} is active.`
          : "A new random cursor is active.",
      });
    } catch (error) {
      setFeedback({
        scope: "randomization",
        type: "error",
        message: getErrorMessage(error),
      });
    } finally {
      setOperation("idle");
    }
  }, [packs, refreshStatus]);

  const handleSizeCommit = useCallback(
    async (sizePercentage) => {
      if (!engineAvailable || !selectedPack || selectedPack.canApply !== true) {
        throw new Error("Cursor size customization is unavailable.");
      }
      setFeedback(null);
      setOperation("sizing");
      try {
        const result = await setCursorThemeSize(
          selectedPack.nativeThemeId ?? selectedPack.id,
          sizePercentage,
        );
        queryClient.setQueryData(["cursor-themes"], (themes) =>
          Array.isArray(themes)
            ? themes.map((theme) =>
                matchesCursorPack(theme, result.nativeThemeId)
                  ? {
                      ...theme,
                      sizePercentage: result.sizePercentage,
                      SizePercentage: result.sizePercentage,
                    }
                  : theme,
              )
            : themes,
        );
        return result;
      } catch (error) {
        setFeedback({
          scope: "catalog",
          type: "error",
          message: getErrorMessage(error),
        });
        throw error;
      } finally {
        setOperation("idle");
      }
    },
    [engineAvailable, queryClient, selectedPack],
  );

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
        scope: "catalog",
        type: "success",
        message: `${selectedPack.variant} is active.`,
      });
    } catch (error) {
      try {
        await refreshStatus();
      } catch {
        // Preserve the operation error; the query retains its previous state.
      }
      setFeedback({
        scope: "catalog",
        type: "error",
        message: getErrorMessage(error),
      });
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
        scope: "catalog",
        type: "success",
        message: "macOS cursor restored.",
      });
    } catch (error) {
      try {
        await refreshStatus();
      } catch {
        // Preserve the operation error; the query retains its previous state.
      }
      setFeedback({
        scope: "catalog",
        type: "error",
        message: getErrorMessage(error),
      });
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
        scope: "catalog",
        type: "success",
        message: warning ? `${message} ${warning}` : message,
      });
    } catch (error) {
      setFeedback({
        scope: "catalog",
        type: "error",
        message: getErrorMessage(error),
      });
    } finally {
      setOperation("idle");
    }
  }, [queryClient]);

  const handleAssignFamily = useCallback(
    async (pack, family) => {
      const identifier = pack?.nativeThemeId ?? pack?.id;
      if (!identifier || pack?.imported !== true) {
        return { ok: false, message: "Only imported cursors can be organized." };
      }
      setFeedback(null);
      setOperation("organizing");
      try {
        const result = await assignImportedCursorFamily([identifier], family);
        await refreshLibraryQueries();
        const assignedFamily = result?.family ?? String(family).trim();
        setFeedback({
          scope: "catalog",
          type: "success",
          message: `${pack.variant} moved to ${assignedFamily}.`,
        });
        return { ok: true, family: assignedFamily };
      } catch (error) {
        const message = getErrorMessage(error);
        setFeedback({ scope: "catalog", type: "error", message });
        return { ok: false, message };
      } finally {
        setOperation("idle");
      }
    },
    [refreshLibraryQueries],
  );

  const handleOpenFamilyEditor = useCallback((pack) => {
    setFamilyName("");
    setFamilyDialogError(null);
    setFamilyEditor(pack);
  }, []);

  const handleCreateFamily = useCallback(
    async (event) => {
      event.preventDefault();
      if (!familyEditor) {
        return;
      }
      const result = await handleAssignFamily(familyEditor, familyName);
      if (result.ok) {
        setFamilyEditor(null);
        setFamilyName("");
        setFamilyDialogError(null);
      } else {
        setFamilyDialogError(result.message);
      }
    },
    [familyEditor, familyName, handleAssignFamily],
  );

  const handleRequestCursorDeletion = useCallback((pack) => {
    if (pack?.imported !== true) {
      return;
    }
    setDeleteTarget({
      kind: "cursor",
      label: pack.variant,
      identifier: pack.nativeThemeId ?? pack.id,
      identifiers: [pack.nativeThemeId ?? pack.id],
    });
  }, []);

  const handleRequestFamilyDeletion = useCallback((family, familyPacks) => {
    if (
      !family ||
      !familyPacks?.length ||
      familyPacks.some((pack) => pack.imported !== true)
    ) {
      return;
    }
    setDeleteTarget({
      kind: "family",
      label: family,
      family,
      identifiers: familyPacks.map(
        (pack) => pack.nativeThemeId ?? pack.id,
      ),
      count: familyPacks.length,
    });
  }, []);

  const handleDeleteConfirmed = useCallback(async () => {
    const target = deleteTarget;
    if (!target) {
      return;
    }
    setDeleteTarget(null);
    setFeedback(null);
    setOperation("deleting");
    try {
      const result =
        target.kind === "family"
          ? await deleteImportedCursorFamily(target.family)
          : await deleteImportedCursor(target.identifier);
      const removedIds = new Set(
        target.identifiers.map((identifier) => identifier.toLowerCase()),
      );
      const currentSelectedPack = packs.find(
        (pack) => pack.id === selectedIdRef.current,
      );
      const selectedWasRemoved =
        currentSelectedPack &&
        [...removedIds].some((identifier) =>
          matchesCursorPack(currentSelectedPack, identifier),
        );
      if (selectedWasRemoved) {
        const nextPack = packs.find(
          (pack) =>
            ![...removedIds].some((identifier) =>
              matchesCursorPack(pack, identifier),
            ),
        );
        selectionWasChanged.current = true;
        setSearch("");
        setSelectedId(nextPack?.id ?? "");
      }
      await refreshLibraryQueries();
      const cleanupPending = Boolean(
        result?.cleanupPending ||
          result?.preferenceCleanupPending ||
          result?.sizePreferenceCleanupPending,
      );
      setFeedback({
        scope: "catalog",
        type: "success",
        message: cleanupPending
          ? `${target.label} was removed; some cleanup is still pending.`
          : `${target.label} was moved to Trash.`,
      });
    } catch (error) {
      setFeedback({
        scope: "catalog",
        type: "error",
        message: getErrorMessage(error),
      });
    } finally {
      setOperation("idle");
    }
  }, [deleteTarget, packs, refreshLibraryQueries]);

  const handleOpenLoginSettings = useCallback(async () => {
    setFeedback(null);
    setOperation("opening-settings");
    try {
      await openLoginItemsSettings();
    } catch (error) {
      setFeedback({
        scope: "catalog",
        type: "error",
        message: getErrorMessage(error),
      });
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
  const selectedPreferenceId = getCursorPreferenceId(selectedPack);
  const selectedFavorite = Boolean(
    selectedPreferenceId &&
    preferences.favorites.cursorIds.includes(selectedPreferenceId),
  );
  const selectedAppearanceRoles = selectedPreferenceId
    ? (preferences.appearance.roles[selectedPreferenceId] ?? [])
    : [];
  const libraryActions = useMemo(
    () => ({
      managementDisabled: operation !== "idle",
      onAssignFamily: (pack, family) => {
        void handleAssignFamily(pack, family);
      },
      onCreateFamily: handleOpenFamilyEditor,
      onDelete: handleRequestCursorDeletion,
      onDeleteFamily: handleRequestFamilyDeletion,
    }),
    [
      handleAssignFamily,
      handleOpenFamilyEditor,
      handleRequestCursorDeletion,
      handleRequestFamilyDeletion,
      operation,
    ],
  );

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background">
      <header className="titlebar-drag relative flex h-14 shrink-0 items-center justify-end border-b border-border/60 pr-3 pl-[78px] sm:pr-4">
        <h1 className="pointer-events-none absolute left-1/2 -translate-x-1/2 truncate text-title-md">
          Cursor Atelier
        </h1>

        <div className="titlebar-no-drag flex shrink-0 items-center gap-2">
          {view === "catalog" ? (
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
          ) : null}
          {view === "catalog" && isMobile ? (
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
                  allPacks={packs}
                  selectedId={selectedId}
                  effectiveId={effectiveId}
                  verifiedActive={verifiedActive}
                  engineAvailable={engineAvailable}
                  preferences={preferences}
                  search={search}
                  onSearch={setSearch}
                  onSelect={handleSelect}
                  onClearSearch={() => setSearch("")}
                  onToggleCursorFavorite={handleToggleCursorFavorite}
                  onToggleFamilyFavorite={handleToggleFamilyFavorite}
                  onToggleAppearanceRole={handleToggleAppearanceRole}
                  libraryActions={libraryActions}
                  loadError={catalogueLoadError}
                  onClose={() => setRailOpen(false)}
                />
              </SheetContent>
            </Sheet>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={view === "settings" ? "Close Settings" : "Settings"}
            aria-pressed={view === "settings"}
            className={cn(view === "settings" && "bg-muted")}
            onClick={() => {
              setFeedback(null);
              setView((current) =>
                current === "settings" ? "catalog" : "settings",
              );
            }}
          >
            <HugeiconsIcon
              icon={Settings02Icon}
              strokeWidth={2}
              aria-hidden="true"
            />
          </Button>
          <AppearancePicker />
        </div>
      </header>

      {view === "settings" ? (
        <SettingsScreen
          packs={packs}
          preferences={preferences}
          onChange={handlePreferenceChange}
          onRandomize={() => void handleRandomize()}
          randomizing={operation === "randomizing"}
          feedback={feedback}
          onClose={() => setView("catalog")}
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <aside className="hidden min-h-0 min-w-0 w-[276px] shrink-0 overflow-hidden border-r border-border/60 bg-sidebar/45 md:flex lg:w-[296px]">
            <PackRail
              packs={filteredPacks}
              allPacks={packs}
              selectedId={selectedId}
              effectiveId={effectiveId}
              verifiedActive={verifiedActive}
              engineAvailable={engineAvailable}
              preferences={preferences}
              search={search}
              onSearch={setSearch}
              onSelect={handleSelect}
              onClearSearch={() => setSearch("")}
              onToggleCursorFavorite={handleToggleCursorFavorite}
              onToggleFamilyFavorite={handleToggleFamilyFavorite}
              onToggleAppearanceRole={handleToggleAppearanceRole}
              libraryActions={libraryActions}
              loadError={catalogueLoadError}
            />
          </aside>
          {selectedPack ? (
            <PackDetails
              key={selectedPack.id}
              pack={selectedPack}
              active={active}
              favorite={selectedFavorite}
              appearanceRoles={selectedAppearanceRoles}
              selectedBySystem={selectedBySystem}
              operation={operation}
              onApply={handleApply}
              onSizeCommit={handleSizeCommit}
              effectiveSizePercentage={effectiveSizePercentage}
              onToggleFavorite={() =>
                handleToggleCursorFavorite(
                  selectedPreferenceId,
                  !selectedFavorite,
                )
              }
              onToggleAppearanceRole={(role) =>
                handleToggleAppearanceRole(
                  selectedPreferenceId,
                  role,
                  !selectedAppearanceRoles.includes(role),
                )
              }
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
      )}

      <Dialog
        open={Boolean(familyEditor)}
        onOpenChange={(open) => {
          if (!open && operation !== "organizing") {
            setFamilyEditor(null);
            setFamilyName("");
            setFamilyDialogError(null);
          }
        }}
      >
        <DialogContent>
          <form className="grid gap-5" onSubmit={handleCreateFamily}>
            <DialogHeader>
              <DialogTitle>New family</DialogTitle>
              <DialogDescription>
                Move {familyEditor?.variant ?? "this cursor"} into a new family.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Input
                value={familyName}
                onChange={(event) => {
                  setFamilyName(event.target.value);
                  setFamilyDialogError(null);
                }}
                maxLength={128}
                autoFocus
                aria-label="Family name"
                placeholder="Family name"
                aria-invalid={familyDialogError ? "true" : undefined}
              />
              {familyDialogError ? (
                <p role="alert" className="text-body-sm text-destructive">
                  {familyDialogError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={operation === "organizing"}
                >
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={!familyName.trim() || operation === "organizing"}
              >
                {operation === "organizing" ? "Moving…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && operation !== "deleting") {
            setDeleteTarget(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.label ?? "imported cursor"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "family"
                ? `This moves all ${deleteTarget.count} imported cursor packs in the family to Trash.`
                : "This moves the imported cursor pack to Trash."}{" "}
              The original downloaded archive is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeleteConfirmed()}>
              Move to Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
