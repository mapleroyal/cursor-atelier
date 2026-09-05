import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Alert02Icon,
  ArrowUpRight01Icon,
  ArrowRight01Icon,
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CommandIcon,
  Cursor01Icon,
  Delete01Icon,
  FavouriteIcon,
  FolderEditIcon,
  FolderFavouriteIcon,
  InformationCircleIcon,
  Moon02Icon,
  Search01Icon,
  Settings02Icon,
  ShuffleIcon,
  Sun02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { SettingsScreen } from "@/components/settings-screen";
import { OnboardingScreen } from "@/components/onboarding-screen";
import { isLinux } from "@/lib/platform";
import * as catalog from "@/lib/cursor-catalog";
import { CURSOR_DTO_SCHEMA_VERSION } from "@/lib/cursor-dto";
import {
  createDefaultCursorPreferences,
  getCursorPreferenceId,
  mergeCursorPreferences,
  normalizeCursorPreferences,
  resolveRandomCursorPool,
} from "@/lib/cursor-preferences";
import {
  DEFAULT_CURSOR_SIZE_PERCENTAGE,
  MAX_CURSOR_SIZE_PERCENTAGE,
  MIN_CURSOR_SIZE_PERCENTAGE,
  applyCursorPreferenceUpdates,
  applyCursorTheme,
  assignImportedCursorFamily,
  deleteImportedCursor,
  deleteImportedCursorFamily,
  getAutomaticSelectionId,
  getAuthoritativeStatus,
  getCursorLibraryPresentationState,
  getCursorErrorMessage,
  getPackScopedFeedback,
  getPackScopedOperation,
  getPackRailNavigationIndex,
  getRandomizationPoolSourceLabel,
  getSelectedStatusVariant,
  getStatusVariant,
  isRestoreAvailable,
  isPackVerifiedActive,
  isRandomizationResultVerified,
  isStatusQueryUnavailable,
  isStatusVerifiedActive,
  isStatusVerifiedRestored,
  importCursorPack,
  isCursorFamilyManagementDisabled,
  matchesCursorPack,
  normalizeCursorSizePercentage,
  openLoginItemsSettings,
  readRevisionStable,
  resolveCursorPreferenceUpdate,
  resolveCursorPoolPacks,
  resolvePackQuerySource,
  restoreCursorState,
  setCursorThemeSize,
} from "@/lib/cursor-ui";
import { cn } from "@/lib/utils";
import {
  ONBOARDING_FAMILIES,
  ONBOARDING_FAMILIES_BY_ID,
} from "@/lib/onboarding-catalog";
import {
  getOnboardingFailureDetail,
  getOnboardingJobLabel,
  groupCursorFamilies,
  isOnboardingJobVisible,
} from "@/lib/onboarding";
import {
  getSystemTheme,
  subscribeToSystemTheme,
  useAppStore,
} from "@/stores/app-store";

const DEFAULT_ROLES = ["default", "text", "pointer", "wait", "progress"];
const CONTEXT_MENU_DISMISS_MS = 100;

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
  if (typeof value === "string" && value) {
    return value;
  }
  return typeof value?.src === "string" && value.src ? value.src : null;
}

function normaliseRole(role, index) {
  if (typeof role === "string") {
    return {
      id: role,
      role,
      name: formatRoleName(role),
      macIdentifier: null,
      src: null,
      frameCount: 1,
      frameDuration: null,
      hotspot: null,
      fallback: false,
    };
  }

  const key = String(
    role?.macIdentifier ?? role?.role ?? role?.name ?? `cursor-${index}`,
  );
  return {
    id: key,
    role: role?.role ?? null,
    name:
      MAC_ROLE_LABELS[key] ?? formatRoleName(role?.name ?? role?.role ?? key),
    macIdentifier: role?.macIdentifier ?? null,
    src: previewSource(role?.src),
    frameCount: Number.isFinite(Number(role?.frameCount))
      ? Number(role.frameCount)
      : 1,
    frameDuration: Number.isFinite(Number(role?.frameDuration))
      ? Number(role.frameDuration)
      : null,
    hotspot: role?.hotspot ?? null,
    fallback: Boolean(role?.fallback),
  };
}

function normalisePack(pack = {}) {
  const id = String(pack.id ?? pack.nativeThemeId ?? "cursor-pack");
  const family = String(pack.family ?? "Cursor pack");
  const variant = String(pack.variant ?? pack.name ?? family);
  const rawRoles =
    Array.isArray(pack.rolePreviews) && pack.rolePreviews.length
      ? pack.rolePreviews
      : (pack.cursorRoles ?? DEFAULT_ROLES);
  const roles = Array.isArray(rawRoles)
    ? rawRoles.map(normaliseRole)
    : DEFAULT_ROLES.map(normaliseRole);
  const resourceAvailable = Boolean(pack.resourceAvailable);
  const canApply = Boolean(pack.canApply);
  const exactRoleCount =
    Array.isArray(pack.rolePreviews) && pack.rolePreviews.length
      ? pack.rolePreviews.length
      : roles.length;

  return {
    id,
    family,
    variant,
    name: String(pack.name ?? variant),
    author: pack.author ?? "",
    license: pack.license ?? "",
    sourceUrl: pack.sourceUrl ?? "",
    nativeThemeId: pack.nativeThemeId ?? id,
    nativeThemeIds: Array.isArray(pack.nativeThemeIds)
      ? [...pack.nativeThemeIds]
      : [],
    resourceAvailable,
    canApply,
    imported: Boolean(pack.imported),
    tags: Array.isArray(pack.tags) ? [...pack.tags] : [],
    cursorRoles: Array.isArray(pack.cursorRoles) ? [...pack.cursorRoles] : [],
    roles,
    roleCount: exactRoleCount,
    cursorCount: Number.isFinite(Number(pack.cursorCount))
      ? Number(pack.cursorCount)
      : exactRoleCount,
    status: pack.status ?? (resourceAvailable ? "available" : "unavailable"),
    sizePercentage: normalizeCursorSizePercentage(pack.sizePercentage),
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

async function getNativeStatus() {
  const method = window.electronAPI?.getCursorStatus;
  if (typeof method !== "function") {
    return {
      schemaVersion: CURSOR_DTO_SCHEMA_VERSION,
      supported: false,
      bridgeAvailable: false,
      statusAvailable: true,
      previewMode: true,
      reason: "Cursor engine unavailable",
      selectedVariantId: null,
      requestedVariantId: null,
      effectiveVariantId: null,
      themeDisplayName: null,
      themeSizePercentage: DEFAULT_CURSOR_SIZE_PERCENTAGE,
      resourceAvailable: false,
      canApply: false,
      desiredEnabled: false,
      effectiveApplied: false,
      persistedEffectiveApplied: false,
      currentSentinelsMatchTheme: false,
      launchAtLoginDesired: false,
      loginApprovalRequired: false,
      loginItemRegistrationCurrent: false,
      transactionPending: false,
      stateDrifted: false,
      lastError: null,
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

async function setNativeAppearanceCursor(appearance, identifier) {
  const setAppearanceCursor = window.electronAPI?.setAppearanceCursor;
  if (typeof setAppearanceCursor !== "function") {
    throw new Error("Light and dark cursor settings are unavailable.");
  }
  return setAppearanceCursor(appearance, identifier);
}

function getAssignedAppearanceModes(preferences, preferenceId) {
  if (!preferenceId) {
    return [];
  }
  const appearance = preferences?.appearance ?? {};
  return ["light", "dark"].filter(
    (mode) => appearance[`${mode}CursorId`] === preferenceId,
  );
}

function isManagementDisabled(managementDisabled, family) {
  return typeof managementDisabled === "function"
    ? managementDisabled(family)
    : Boolean(managementDisabled);
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
  appearanceApplicationUnavailable = false,
  appearanceAssignmentDisabled = false,
  managementDisabled = false,
  preferencesDisabled = false,
  onAssignFamily,
  onCreateFamily,
  onDelete,
  onToggleFavorite,
  onAssignAppearanceCursor,
  children,
}) {
  const preferenceId = getCursorPreferenceId(pack);
  const roles = Array.isArray(appearanceRoles) ? appearanceRoles : [];
  const canManageImport = pack.imported === true;
  const managementUnavailable = isManagementDisabled(
    managementDisabled,
    pack.family,
  );
  const otherFamilies = familyNames.filter(
    (family) => family.toLocaleLowerCase() !== pack.family.toLocaleLowerCase(),
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-64">
        <ContextMenuItem
          disabled={preferencesDisabled}
          onSelect={() => onToggleFavorite(preferenceId, !favorite)}
        >
          <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} />
          {favorite ? "Remove from Favorites" : "Add to Favorites"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={
            preferencesDisabled ||
            appearanceAssignmentDisabled ||
            (!roles.includes("light") &&
              (appearanceApplicationUnavailable || pack.canApply !== true))
          }
          onSelect={() => onAssignAppearanceCursor(preferenceId, "light")}
        >
          <HugeiconsIcon icon={Sun02Icon} strokeWidth={2} />
          Set as default light mode cursor
          {roles.includes("light") ? (
            <HugeiconsIcon
              icon={Tick02Icon}
              strokeWidth={2}
              className="ml-auto"
              aria-hidden="true"
            />
          ) : null}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={
            preferencesDisabled ||
            appearanceAssignmentDisabled ||
            (!roles.includes("dark") &&
              (appearanceApplicationUnavailable || pack.canApply !== true))
          }
          onSelect={() => onAssignAppearanceCursor(preferenceId, "dark")}
        >
          <HugeiconsIcon icon={Moon02Icon} strokeWidth={2} />
          Set as default dark mode cursor
          {roles.includes("dark") ? (
            <HugeiconsIcon
              icon={Tick02Icon}
              strokeWidth={2}
              className="ml-auto"
              aria-hidden="true"
            />
          ) : null}
        </ContextMenuItem>
        {canManageImport ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={managementUnavailable}>
                <HugeiconsIcon icon={FolderEditIcon} strokeWidth={2} />
                Move to family
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-w-72 min-w-48">
                {otherFamilies.map((family) => (
                  <ContextMenuItem
                    key={family}
                    disabled={isManagementDisabled(managementDisabled, family)}
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
              disabled={managementUnavailable}
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
  preferencesDisabled = false,
  onDelete,
  onToggleFavorite,
  children,
}) {
  const canDelete =
    familyPacks.length > 0 &&
    familyPacks.some((pack) => pack.imported === true);
  const managementUnavailable = isManagementDisabled(
    managementDisabled,
    family,
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={preferencesDisabled}
          onSelect={() => onToggleFavorite(family, !favorite)}
        >
          <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} />
          {favorite ? "Remove from Favorites" : "Add to Favorites"}
        </ContextMenuItem>
        {canDelete ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              disabled={managementUnavailable}
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
  onAssignAppearanceCursor,
}) {
  return (
    <PackContextActions
      pack={pack}
      favorite={favorite}
      appearanceRoles={appearanceRoles}
      {...libraryActions}
      onToggleFavorite={onToggleFavorite}
      onAssignAppearanceCursor={onAssignAppearanceCursor}
    >
      <button
        type="button"
        onClick={() => onSelect(pack.id)}
        className="group flex min-w-0 w-full items-center gap-2.5 rounded-2xl px-2 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60"
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

function FamilyJobStatus({ job }) {
  const failed = job.status === "failed";
  const label = getOnboardingJobLabel(job);

  return (
    <span
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1.5 text-[0.65rem] font-normal tracking-normal",
        failed ? "text-destructive" : "text-muted-foreground/80",
      )}
      title={failed ? (job.error ?? "Import failed.") : job.currentVariant}
    >
      {failed ? (
        <HugeiconsIcon
          icon={Alert02Icon}
          strokeWidth={2}
          className="size-3.5"
          aria-hidden="true"
        />
      ) : (
        <span
          aria-hidden="true"
          data-corner-shape="round"
          className="size-3 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground"
        />
      )}
      <span className="max-w-24 truncate">{label}</span>
    </span>
  );
}

function PackRail({
  packs,
  allPacks = packs,
  selectedId,
  effectiveId,
  verifiedActive,
  engineAvailable,
  preferencesAvailable,
  preferences,
  search,
  onSearch,
  onSelect,
  onClearSearch,
  onToggleCursorFavorite,
  onToggleFamilyFavorite,
  onAssignAppearanceCursor,
  libraryActions = {},
  familyJobs = [],
  onRetryFamily,
  loadError,
  loading = false,
  onClose,
  className,
}) {
  const optionRefs = useRef(new Map());
  const familyRefs = useRef(new Map());
  const [expandedFamilies, setExpandedFamilies] = useState(() => new Set());
  const [expandedPools, setExpandedPools] = useState(
    () => new Set(["light", "dark"]),
  );
  const searchActive = Boolean(search.trim());
  const groups = useMemo(
    () => groupCursorFamilies(packs, familyJobs, search),
    [familyJobs, packs, search],
  );
  const visiblePacks = useMemo(
    () =>
      groups.flatMap(({ family, familyPacks }) =>
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
  const packLibraryActions = {
    ...libraryActions,
    familyNames,
    appearanceApplicationUnavailable: !engineAvailable,
    appearanceAssignmentDisabled:
      libraryActions.operationDisabled || libraryActions.preferencesSaving,
    preferencesDisabled: !preferencesAvailable,
  };
  const currentPack = verifiedActive
    ? allPacks.find((pack) => matchesCursorPack(pack, effectiveId))
    : null;
  const assignedCurrentPacks = ["light", "dark"]
    .map((appearance) => {
      const identifier = preferences.appearance[`${appearance}CursorId`];
      const pack = identifier
        ? allPacks.find((candidate) => matchesCursorPack(candidate, identifier))
        : null;
      return pack ? { appearance, pack } : null;
    })
    .filter(Boolean);
  const currentEntries = currentPack
    ? [{ pack: currentPack, label: currentPack.family }]
    : [];
  const defaultEntries =
    assignedCurrentPacks.length === 2 &&
    assignedCurrentPacks[0].pack.id === assignedCurrentPacks[1].pack.id
      ? [
          {
            appearance: "both",
            pack: assignedCurrentPacks[0].pack,
            label: `Light & Dark · ${assignedCurrentPacks[0].pack.family}`,
          },
        ]
      : assignedCurrentPacks.map(({ appearance, pack }) => ({
          appearance,
          pack,
          label: `${appearance === "light" ? "Light" : "Dark"} · ${pack.family}`,
        }));
  const favoritePacks = allPacks.filter((pack) =>
    favoriteCursorIds.has(getCursorPreferenceId(pack)),
  );
  const hasFavorites = favoritePacks.length > 0 || favoriteFamilies.size > 0;
  const randomizationPools = ["light", "dark"].map((appearance) => {
    const identifiers = preferences.randomization.pools[appearance];
    return {
      appearance,
      includesAll: identifiers.length === 0,
      packs: resolveCursorPoolPacks(allPacks, identifiers),
    };
  });
  const implicitPoolLabel = getRandomizationPoolSourceLabel(preferences);

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

  const setPoolExpanded = useCallback((appearance, expanded) => {
    setExpandedPools((current) => {
      const next = new Set(current);
      if (expanded) {
        next.add(appearance);
      } else {
        next.delete(appearance);
      }
      return next;
    });
  }, []);

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
            {!loading && !loadError ? (
              <span className="type-numeric text-body-sm text-muted-foreground">
                {packs.length}
              </span>
            ) : null}
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
                aria-hidden="true"
                data-corner-shape="round"
                className={cn(
                  "size-1.5 rounded-full bg-muted-foreground/40",
                  verifiedActive && "bg-primary",
                )}
              />
              {loading
                ? "Loading"
                : familyJobs.some((job) => job.status !== "failed")
                  ? "Adding"
                  : !engineAvailable
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
                icon={Cancel01Icon}
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
        {!loading && !loadError && allPacks.length ? (
          <nav aria-label="Cursor shortcuts" className="pb-2">
            {currentEntries.length ? (
              <div>
                <h3 className="px-2.5 pt-1 pb-0.5 text-label-sm text-muted-foreground">
                  Current
                </h3>
                <div className="space-y-0.5">
                  {currentEntries.map(({ appearance, label, pack }) => (
                    <PackRailShortcut
                      key={appearance ?? pack.id}
                      pack={pack}
                      label={label}
                      active={
                        verifiedActive && matchesCursorPack(pack, effectiveId)
                      }
                      favorite={favoriteCursorIds.has(
                        getCursorPreferenceId(pack),
                      )}
                      appearanceRoles={getAssignedAppearanceModes(
                        preferences,
                        getCursorPreferenceId(pack),
                      )}
                      libraryActions={packLibraryActions}
                      onSelect={selectShortcut}
                      onToggleFavorite={onToggleCursorFavorite}
                      onAssignAppearanceCursor={onAssignAppearanceCursor}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {currentEntries.length && defaultEntries.length ? (
              <Separator className="mx-2 my-2 w-auto" />
            ) : null}

            {defaultEntries.length ? (
              <div>
                <h3 className="px-2.5 pt-1 pb-0.5 text-label-sm text-muted-foreground">
                  Defaults
                </h3>
                <div className="space-y-0.5">
                  {defaultEntries.map(({ appearance, label, pack }) => (
                    <PackRailShortcut
                      key={appearance}
                      pack={pack}
                      label={label}
                      active={
                        verifiedActive && matchesCursorPack(pack, effectiveId)
                      }
                      favorite={favoriteCursorIds.has(
                        getCursorPreferenceId(pack),
                      )}
                      appearanceRoles={getAssignedAppearanceModes(
                        preferences,
                        getCursorPreferenceId(pack),
                      )}
                      libraryActions={packLibraryActions}
                      onSelect={selectShortcut}
                      onToggleFavorite={onToggleCursorFavorite}
                      onAssignAppearanceCursor={onAssignAppearanceCursor}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {(currentEntries.length || defaultEntries.length) &&
            hasFavorites ? (
              <Separator className="mx-2 my-2 w-auto" />
            ) : null}

            {hasFavorites ? (
              <div>
                <h3 className="px-2.5 pt-1 pb-0.5 text-label-sm text-muted-foreground">
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
                        preferencesDisabled={!preferencesAvailable}
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
                      appearanceRoles={getAssignedAppearanceModes(
                        preferences,
                        getCursorPreferenceId(pack),
                      )}
                      libraryActions={packLibraryActions}
                      onSelect={selectShortcut}
                      onToggleFavorite={onToggleCursorFavorite}
                      onAssignAppearanceCursor={onAssignAppearanceCursor}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {currentEntries.length || defaultEntries.length || hasFavorites ? (
              <Separator className="mx-2 my-2 w-auto" />
            ) : null}

            <section aria-labelledby="randomization-pools-heading">
              <h3
                id="randomization-pools-heading"
                className="px-2.5 pt-1 pb-0.5 text-label-sm text-muted-foreground"
              >
                Randomization Pools
              </h3>
              <div className="space-y-0.5">
                {randomizationPools.map(
                  ({ appearance, includesAll, packs: poolPacks }) => {
                    const label = appearance === "light" ? "Light" : "Dark";
                    const expanded = expandedPools.has(appearance);
                    const poolHeader = (
                      <>
                        <HugeiconsIcon
                          icon={ArrowRight01Icon}
                          strokeWidth={2}
                          className={cn(
                            "size-3.5 shrink-0 transition-transform",
                            !poolPacks.length && "invisible",
                            poolPacks.length && expanded && "rotate-90",
                          )}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {label} mode
                        </span>
                        <span className="type-numeric text-[0.65rem] font-normal text-muted-foreground/75">
                          {includesAll ? implicitPoolLabel : poolPacks.length}
                        </span>
                      </>
                    );

                    return (
                      <Collapsible
                        key={appearance}
                        open={expanded}
                        onOpenChange={(open) =>
                          setPoolExpanded(appearance, open)
                        }
                        asChild
                      >
                        <section
                          aria-label={`${label} mode randomization pool`}
                          className="min-w-0"
                        >
                          {poolPacks.length ? (
                            <CollapsibleTrigger asChild>
                              <button
                                type="button"
                                className="group flex w-full min-w-0 items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-label-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                              >
                                {poolHeader}
                              </button>
                            </CollapsibleTrigger>
                          ) : (
                            <div className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-label-sm text-muted-foreground">
                              {poolHeader}
                            </div>
                          )}
                          {poolPacks.length ? (
                            <CollapsibleContent animated>
                              <div
                                role="list"
                                aria-label={`${label} mode cursor pool`}
                                className="ml-3.5 min-w-0 space-y-0.5 border-l border-sidebar-border py-0.5 pl-2"
                              >
                                {poolPacks.map((pack) => (
                                  <div
                                    key={pack.id}
                                    role="listitem"
                                    data-pool-cursor-id={getCursorPreferenceId(
                                      pack,
                                    )}
                                  >
                                    <PackRailShortcut
                                      pack={pack}
                                      active={
                                        verifiedActive &&
                                        matchesCursorPack(pack, effectiveId)
                                      }
                                      favorite={favoriteCursorIds.has(
                                        getCursorPreferenceId(pack),
                                      )}
                                      appearanceRoles={getAssignedAppearanceModes(
                                        preferences,
                                        getCursorPreferenceId(pack),
                                      )}
                                      libraryActions={packLibraryActions}
                                      onSelect={selectShortcut}
                                      onToggleFavorite={onToggleCursorFavorite}
                                      onAssignAppearanceCursor={
                                        onAssignAppearanceCursor
                                      }
                                    />
                                  </div>
                                ))}
                              </div>
                            </CollapsibleContent>
                          ) : null}
                        </section>
                      </Collapsible>
                    );
                  },
                )}
              </div>
            </section>
            <Separator className="mx-2 mt-2 w-auto" />
          </nav>
        ) : null}

        {loading ? (
          <p
            role="status"
            className="px-3 py-8 text-center text-body-sm text-muted-foreground"
          >
            Loading cursor packs…
          </p>
        ) : loadError && !groups.length ? (
          <p className="px-3 py-8 text-center text-body-sm text-muted-foreground">
            Unavailable
          </p>
        ) : groups.length ? (
          <nav aria-label="Cursor packs">
            {groups.map(({ family, familyPacks, job }) => {
              const expanded = searchActive || expandedFamilies.has(family);
              const familyFailed = job?.status === "failed";
              const familyActive = familyPacks.some(
                (pack) =>
                  verifiedActive && matchesCursorPack(pack, effectiveId),
              );
              const familyFavorite = favoriteFamilies.has(family);
              const familyHeading = (
                <>
                  {!searchActive ? (
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      strokeWidth={2}
                      className={cn(
                        "size-3.5 shrink-0 transition-transform",
                        expanded && "rotate-90",
                      )}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{family}</span>
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
                  {job ? (
                    <FamilyJobStatus job={job} />
                  ) : (
                    <span className="type-numeric text-[0.65rem] font-normal text-muted-foreground/75">
                      {familyPacks.length}
                    </span>
                  )}
                </>
              );
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
                      preferencesDisabled={!preferencesAvailable}
                      onDelete={libraryActions.onDeleteFamily}
                      onToggleFavorite={onToggleFamilyFavorite}
                    >
                      <div className="flex min-w-0 items-center">
                        {searchActive ? (
                          <div
                            className={cn(
                              "flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-label-sm text-muted-foreground",
                              job && !familyFailed && "opacity-60",
                              familyFailed && "text-destructive",
                            )}
                          >
                            {familyHeading}
                          </div>
                        ) : (
                          <CollapsibleTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                "group flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-left text-label-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
                                job && !familyFailed && "opacity-60",
                                familyFailed && "text-destructive",
                              )}
                            >
                              {familyHeading}
                            </button>
                          </CollapsibleTrigger>
                        )}
                        {familyFailed ? (
                          <Button
                            type="button"
                            variant="destructive-text"
                            size="icon-xs"
                            className="mr-1 shrink-0"
                            onClick={() => onRetryFamily(job.familyId)}
                            aria-label={`Retry ${family}`}
                          >
                            <HugeiconsIcon
                              icon={ArrowReloadHorizontalIcon}
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                          </Button>
                        ) : null}
                      </div>
                    </FamilyContextActions>
                    <CollapsibleContent>
                      <div className="min-w-0 space-y-0.5 pb-1">
                        {familyFailed ? (
                          <p
                            role="alert"
                            className="select-text whitespace-pre-wrap break-words px-2.5 py-1.5 text-body-sm text-destructive"
                          >
                            {getOnboardingFailureDetail(job)}
                          </p>
                        ) : null}
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
                              appearanceRoles={getAssignedAppearanceModes(
                                preferences,
                                preferenceId,
                              )}
                              {...packLibraryActions}
                              onToggleFavorite={onToggleCursorFavorite}
                              onAssignAppearanceCursor={
                                onAssignAppearanceCursor
                              }
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
                                data-pack-option=""
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
            {searchActive ? "No matches" : "No cursor packs"}
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
  randomizationRoles = [],
  selectedBySystem,
  operation,
  operationTargetPackId,
  preferencesSaving,
  onApply,
  onSizeCommit,
  onToggleFavorite,
  onAssignAppearanceCursor,
  onToggleRandomizationRole,
  onOpenLoginSettings,
  feedback,
  engineAvailable,
  preferencesAvailable,
  preferencesError,
  preferencesErrorMessage,
  onRetryPreferences,
  preferencesRetrying,
  loginApprovalRequired,
  statusError,
  statusErrorMessage,
  onRetryStatus,
  statusRetrying,
}) {
  const cursorBusy = operation !== "idle";
  const packOperation = getPackScopedOperation(
    operation,
    operationTargetPackId,
    pack.id,
  );
  const canApply = engineAvailable && pack.canApply === true;
  const [sizeDraft, setSizeDraft] = useState(null);
  const previewSize = sizeDraft ?? pack.sizePercentage;
  const previewRoles = pack.roles.filter((role) => role.src);
  const count = previewRoles.length || pack.roleCount || pack.cursorCount;
  const previewPixels = (32 * previewSize) / 100;
  const lightAssigned = appearanceRoles.includes("light");
  const darkAssigned = appearanceRoles.includes("dark");
  const lightActionLabel = lightAssigned
    ? "Clear the default light mode cursor"
    : `Set ${pack.variant} as the default light mode cursor`;
  const darkActionLabel = darkAssigned
    ? "Clear the default dark mode cursor"
    : `Set ${pack.variant} as the default dark mode cursor`;
  const pendingDetailMessage =
    packOperation === "sizing"
      ? "Saving size…"
      : packOperation === "assigning-light"
        ? "Saving light mode cursor…"
        : packOperation === "assigning-dark"
          ? "Saving dark mode cursor…"
          : null;
  const packFeedback = getPackScopedFeedback(feedback, pack.id);
  const detailFeedback =
    packFeedback ??
    (pendingDetailMessage
      ? { type: "pending", message: pendingDetailMessage }
      : null);

  const commitSize = useCallback(
    (values) => {
      const nextSize = normalizeCursorSizePercentage(
        values?.[0],
        pack.sizePercentage,
      );
      void Promise.resolve(onSizeCommit(nextSize)).then(
        () => setSizeDraft(null),
        () => setSizeDraft(null),
      );
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
              <h1 className="truncate text-headline-md">{pack.variant}</h1>
              {pack.sourceUrl ? (
                <a
                  href={pack.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 inline-flex items-center gap-1 truncate text-body-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Source
                  <HugeiconsIcon
                    icon={ArrowUpRight01Icon}
                    strokeWidth={2}
                    className="size-3"
                    aria-hidden="true"
                  />
                </a>
              ) : null}
            </div>
          </div>

          <TooltipProvider>
            <div className="flex shrink-0 items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={
                        favorite ? "Remove from Favorites" : "Add to Favorites"
                      }
                      disabled={!preferencesAvailable}
                      className={cn(
                        "text-muted-foreground",
                        favorite && "text-rose-500 hover:text-rose-500",
                      )}
                      onClick={onToggleFavorite}
                    />
                  }
                >
                  <HugeiconsIcon
                    icon={FavouriteIcon}
                    strokeWidth={2}
                    className={cn("size-4", favorite && "fill-current")}
                    aria-hidden="true"
                  />
                </TooltipTrigger>
                <TooltipContent>
                  {favorite ? "Remove from Favorites" : "Add to Favorites"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-pressed={lightAssigned}
                      aria-label={lightActionLabel}
                      disabled={
                        cursorBusy ||
                        preferencesSaving ||
                        !preferencesAvailable ||
                        (!lightAssigned && !canApply)
                      }
                      className={cn(
                        "text-muted-foreground",
                        lightAssigned &&
                          "text-amber-500 hover:text-amber-500 dark:text-amber-400 dark:hover:text-amber-400",
                      )}
                      onClick={() => onAssignAppearanceCursor("light")}
                    />
                  }
                >
                  <HugeiconsIcon
                    icon={Sun02Icon}
                    strokeWidth={2}
                    className="size-4"
                    aria-hidden="true"
                  />
                </TooltipTrigger>
                <TooltipContent>{lightActionLabel}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-pressed={darkAssigned}
                      aria-label={darkActionLabel}
                      disabled={
                        cursorBusy ||
                        preferencesSaving ||
                        !preferencesAvailable ||
                        (!darkAssigned && !canApply)
                      }
                      className={cn(
                        "text-muted-foreground",
                        darkAssigned &&
                          "text-indigo-500 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-300",
                      )}
                      onClick={() => onAssignAppearanceCursor("dark")}
                    />
                  }
                >
                  <HugeiconsIcon
                    icon={Moon02Icon}
                    strokeWidth={2}
                    className="size-4"
                    aria-hidden="true"
                  />
                </TooltipTrigger>
                <TooltipContent>{darkActionLabel}</TooltipContent>
              </Tooltip>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!canApply || !preferencesAvailable}
                  >
                    Add to…
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  aria-label="Add to randomization pools"
                  className="grid gap-1"
                >
                  {[
                    ["light", "Light mode randomization pool"],
                    ["dark", "Dark mode randomization pool"],
                  ].map(([role, label]) => {
                    const selected = randomizationRoles.includes(role);
                    return (
                      <button
                        key={role}
                        type="button"
                        aria-pressed={selected}
                        className="text-body-md flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent aria-pressed:bg-accent aria-pressed:text-label-lg"
                        onClick={() => onToggleRandomizationRole(role)}
                      >
                        <span className="min-w-0 flex-1">{label}</span>
                        {selected ? (
                          <HugeiconsIcon
                            icon={Tick02Icon}
                            strokeWidth={2}
                            className="size-4 shrink-0"
                            aria-hidden="true"
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
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

          {preferencesError ? (
            <div
              role="alert"
              className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-muted-foreground"
            >
              <span>{preferencesErrorMessage}</span>
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
            </div>
          ) : null}

          {detailFeedback ? (
            <div
              role={detailFeedback.type === "error" ? "alert" : "status"}
              className={cn(
                "mb-5 flex items-center gap-2 text-body-sm",
                detailFeedback.type === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              <HugeiconsIcon
                icon={
                  detailFeedback.type === "success"
                    ? CheckmarkCircle02Icon
                    : InformationCircleIcon
                }
                strokeWidth={2}
                className="size-4 shrink-0"
                aria-hidden="true"
              />
              <span>{detailFeedback.message}</span>
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
                disabled={cursorBusy}
              >
                {packOperation === "opening-settings"
                  ? "Opening…"
                  : "Open Settings"}
              </Button>
            </div>
          ) : null}

          <div className="mb-6 grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-5 border-b border-border/60 pb-6">
            <div
              data-testid="cursor-size-preview"
              className="relative flex size-20 items-center justify-center rounded-xl bg-muted/45"
            >
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
              <span className="type-numeric absolute right-1.5 bottom-1.5 rounded-sm bg-background/80 px-1 py-0.5 text-[0.65rem] leading-3 text-muted-foreground">
                {previewSize}%
              </span>
            </div>
            <div className="min-w-0">
              <div className="mb-3 flex items-baseline gap-4">
                <span className="flex items-center gap-1.5 text-title-md">
                  Size
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label="About cursor sizing"
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
                        For the applied size to match this preview, set the
                        system slider in System Settings → Accessibility →
                        Display → Pointer → Pointer Size all the way to its
                        leftmost position.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Slider
                  aria-label={`${pack.variant} cursor size`}
                  min={MIN_CURSOR_SIZE_PERCENTAGE}
                  max={MAX_CURSOR_SIZE_PERCENTAGE}
                  step={5}
                  value={[previewSize]}
                  onValueChange={(values) =>
                    setSizeDraft(
                      normalizeCursorSizePercentage(
                        values?.[0],
                        DEFAULT_CURSOR_SIZE_PERCENTAGE,
                      ),
                    )
                  }
                  onValueCommit={commitSize}
                  disabled={cursorBusy || !canApply}
                  className="min-w-0 flex-1"
                />
                {engineAvailable ? (
                  <Button
                    type="button"
                    variant={active ? "outline" : "default"}
                    size="sm"
                    disabled={cursorBusy || !canApply}
                    onClick={onApply}
                  >
                    {packOperation === "applying"
                      ? "Applying…"
                      : active
                        ? "Reapply"
                        : "Apply"}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="text-title-md">Cursors</h2>
            <span className="type-numeric text-body-sm text-muted-foreground">
              {count} {count === 1 ? "role" : "roles"}
            </span>
          </div>

          {previewRoles.length ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-x-4 gap-y-5 sm:grid-cols-[repeat(auto-fit,minmax(124px,1fr))]">
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

function EmptyLibrary({ adding = false, loading = false }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-8 text-center">
      <div
        role={loading ? "status" : undefined}
        className="grid justify-items-center gap-2 text-muted-foreground"
      >
        {loading ? (
          <span
            aria-hidden="true"
            data-corner-shape="round"
            className="size-4 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground"
          />
        ) : (
          <HugeiconsIcon
            icon={Cursor01Icon}
            strokeWidth={1.6}
            className="size-7 opacity-60"
            aria-hidden="true"
          />
        )}
        <p className="text-body-md">
          {loading
            ? "Loading cursor packs…"
            : adding
              ? "Adding cursor packs…"
              : "No cursor packs"}
        </p>
      </div>
    </section>
  );
}

function ImportButton({ disabled, importing, onImport }) {
  const [open, setOpen] = useState(false);
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={isLinux ? undefined : () => onImport()}
    >
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden="true" />
      {importing ? "Importing…" : "Import"}
    </Button>
  );
  if (!isLinux) {
    return button;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent align="end" className="grid w-40 gap-1 p-1">
        {[
          [false, "Import File…"],
          [true, "Import Folder…"],
        ].map(([directory, label]) => (
          <Button
            key={label}
            variant="ghost"
            size="sm"
            className="justify-start"
            onClick={() => {
              setOpen(false);
              void onImport({ directory });
            }}
          >
            {label}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function HomeRoute() {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const themeMode = useAppStore((state) => state.themeMode);
  const themeError = useAppStore((state) => state.themeError);
  const setThemeMode = useAppStore((state) => state.setThemeMode);
  const onboarding = useAppStore((state) => state.onboarding);
  const onboardingLoading = useAppStore((state) => state.onboardingLoading);
  const hydrateOnboarding = useAppStore((state) => state.hydrateOnboarding);
  const completeOnboarding = useAppStore((state) => state.completeOnboarding);
  const retryOnboardingImport = useAppStore(
    (state) => state.retryOnboardingImport,
  );
  const syncOnboarding = useAppStore((state) => state.syncOnboarding);
  const [view, setView] = useState("catalog");
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState("idle");
  const [operationTargetPackId, setOperationTargetPackId] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [railOpen, setRailOpen] = useState(false);
  const [familyEditor, setFamilyEditor] = useState(null);
  const [familyName, setFamilyName] = useState("");
  const [familyDialogError, setFamilyDialogError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [selectionWasChanged, setSelectionWasChanged] = useState(false);
  const [subscriptionsReady, setSubscriptionsReady] = useState(false);
  const [pendingPreferenceCount, setPendingPreferenceCount] = useState(0);
  const [systemAppearance, setSystemAppearance] = useState(() =>
    getSystemTheme(),
  );
  const operationRef = useRef(null);
  const eventRevisionRef = useRef({ preferences: 0, status: 0, themes: 0 });
  const pendingPreferenceUpdatesRef = useRef([]);
  const preferenceRequestIdRef = useRef(0);
  const preferenceSaveQueueRef = useRef(Promise.resolve());
  const authoritativePreferencesRef = useRef(createDefaultCursorPreferences());
  const scheduleCorrectionRef = useRef(null);

  const displayPendingPreferences = useCallback((nextPreferences) => {
    const authoritative = normalizeCursorPreferences(nextPreferences);
    authoritativePreferencesRef.current = authoritative;
    return applyCursorPreferenceUpdates(
      authoritative,
      pendingPreferenceUpdatesRef.current,
    );
  }, []);

  const beginOperation = useCallback((kind, targetPackId = null) => {
    if (operationRef.current) {
      return null;
    }
    const token = { kind, targetPackId };
    operationRef.current = token;
    setOperationTargetPackId(targetPackId);
    setOperation(kind);
    return token;
  }, []);

  const endOperation = useCallback((token) => {
    if (operationRef.current !== token) {
      return;
    }
    operationRef.current = null;
    setOperationTargetPackId(null);
    setOperation("idle");
  }, []);

  useEffect(
    () => subscribeToSystemTheme(setSystemAppearance),
    [setSystemAppearance],
  );

  useEffect(() => {
    const unsubscribe =
      window.electronAPI?.onOnboardingChanged?.(syncOnboarding);
    void hydrateOnboarding();
    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [hydrateOnboarding, syncOnboarding]);

  useEffect(() => {
    const api = window.electronAPI;
    const unsubscribers = [];
    if (typeof api?.onCursorPreferencesChanged === "function") {
      unsubscribers.push(
        api.onCursorPreferencesChanged((nextPreferences) => {
          eventRevisionRef.current.preferences += 1;
          const displayedPreferences =
            displayPendingPreferences(nextPreferences);
          queryClient.setQueryData(
            ["cursor-preferences"],
            displayedPreferences,
          );
        }),
      );
    }
    if (typeof api?.onCursorChanged === "function") {
      unsubscribers.push(
        api.onCursorChanged((event) => {
          if (event?.reason === "renderer-size-preference") {
            eventRevisionRef.current.themes += 1;
            void queryClient.invalidateQueries({ queryKey: ["cursor-themes"] });
            return;
          }
          eventRevisionRef.current.status += 1;
          void queryClient.invalidateQueries({ queryKey: ["cursor-status"] });
        }),
      );
    }
    if (typeof api?.onCursorLibraryChanged === "function") {
      unsubscribers.push(
        api.onCursorLibraryChanged(() => {
          eventRevisionRef.current.preferences += 1;
          eventRevisionRef.current.status += 1;
          eventRevisionRef.current.themes += 1;
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ["cursor-themes"] }),
            queryClient.invalidateQueries({
              queryKey: ["cursor-preferences"],
            }),
            queryClient.invalidateQueries({ queryKey: ["cursor-status"] }),
          ]);
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

    // Initial reads are enabled only after every listener is attached. This
    // ensures startup automation cannot publish a change into a blind window.
    const readyTimer = window.setTimeout(() => setSubscriptionsReady(true), 0);

    return () => {
      window.clearTimeout(readyTimer);
      for (const unsubscribe of unsubscribers) {
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      }
    };
  }, [displayPendingPreferences, queryClient]);

  const readAuthoritativePreferencesSnapshot = useCallback(async () => {
    const snapshot = await readRevisionStable(
      eventRevisionRef,
      "preferences",
      getNativePreferences,
    );
    const authoritative = normalizeCursorPreferences(snapshot);
    authoritativePreferencesRef.current = authoritative;
    return authoritative;
  }, []);

  const readPreferencesSnapshot = useCallback(async () => {
    return applyCursorPreferenceUpdates(
      await readAuthoritativePreferencesSnapshot(),
      pendingPreferenceUpdatesRef.current,
    );
  }, [readAuthoritativePreferencesSnapshot]);

  const readThemesSnapshot = useCallback(async () => {
    return readRevisionStable(eventRevisionRef, "themes", getNativeThemes);
  }, []);

  const readStatusSnapshot = useCallback(async () => {
    return readRevisionStable(eventRevisionRef, "status", getNativeStatus);
  }, []);

  const preferencesQuery = useQuery({
    queryKey: ["cursor-preferences"],
    queryFn: readPreferencesSnapshot,
    enabled: subscriptionsReady,
    staleTime: Infinity,
    retry: false,
  });
  const preferences = useMemo(
    () => normalizeCursorPreferences(preferencesQuery.data),
    [preferencesQuery.data],
  );
  const preferencesAvailable = preferencesQuery.isSuccess;
  const preferencesErrorMessage = preferencesQuery.error
    ? getCursorErrorMessage(preferencesQuery.error)
    : "Couldn’t load cursor preferences.";

  const nativeThemesQuery = useQuery({
    queryKey: ["cursor-themes"],
    queryFn: readThemesSnapshot,
    enabled: subscriptionsReady,
    staleTime: 15_000,
    retry: false,
  });
  const nativeThemeData = nativeThemesQuery.data;
  const nativeThemeQueryError = nativeThemesQuery.isError;
  const nativeThemeQuerySuccess = nativeThemesQuery.isSuccess;
  const cataloguePresentationState =
    getCursorLibraryPresentationState(nativeThemesQuery);
  const catalogueLoadError = cataloguePresentationState === "error";

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
      [],
    );
    return source.map(normalisePack);
  }, [nativeThemeData, nativeThemeQueryError, nativeThemeQuerySuccess]);

  const statusQuery = useQuery({
    queryKey: ["cursor-status"],
    queryFn: readStatusSnapshot,
    enabled: subscriptionsReady,
    staleTime: 10_000,
    retry: false,
  });
  const initialCursorDataLoading = Boolean(
    !catalogueLoadError &&
    (cataloguePresentationState === "loading" ||
      preferencesQuery.isPending ||
      statusQuery.isPending),
  );

  const statusUnavailable = isStatusQueryUnavailable(statusQuery);
  const authoritativeStatus = getAuthoritativeStatus(statusQuery);
  const effectiveId = getStatusVariant(authoritativeStatus);
  const selectedStatusId = getSelectedStatusVariant(authoritativeStatus);
  const previewMode = Boolean(authoritativeStatus?.previewMode);
  const statusError =
    statusQuery.error ??
    statusQuery.data?.reason ??
    statusQuery.data?.lastError;
  const statusErrorMessage = statusError
    ? getCursorErrorMessage(statusError)
    : "Cursor status unavailable.";
  const nativeThemeListAvailable = Boolean(
    Array.isArray(nativeThemeData) && nativeThemeData.length,
  );
  const nativeEngineAvailable = Boolean(
    !statusUnavailable &&
    authoritativeStatus?.bridgeAvailable &&
    authoritativeStatus?.statusAvailable !== false &&
    authoritativeStatus?.supported !== false &&
    !previewMode,
  );
  const engineAvailable = Boolean(
    nativeThemeListAvailable && !nativeThemeQueryError && nativeEngineAvailable,
  );
  const randomizationPoolSizes = useMemo(
    () => ({
      light: resolveRandomCursorPool(packs, preferences, "light").length,
      dark: resolveRandomCursorPool(packs, preferences, "dark").length,
    }),
    [packs, preferences],
  );
  const canRandomize = Boolean(
    engineAvailable &&
    preferencesAvailable &&
    randomizationPoolSizes[systemAppearance] > 0,
  );
  const hasCompleteRandomizationPools = Boolean(
    randomizationPoolSizes.light > 0 && randomizationPoolSizes.dark > 0,
  );
  const canScheduleRandomization = Boolean(
    engineAvailable && preferencesAvailable && hasCompleteRandomizationPools,
  );
  const missingScheduleAppearance = ["light", "dark"].find(
    (appearance) => randomizationPoolSizes[appearance] === 0,
  );
  const scheduleUnavailableMessage =
    engineAvailable &&
    randomizationPoolSizes[systemAppearance] > 0 &&
    missingScheduleAppearance
      ? `Scheduling also needs a ${missingScheduleAppearance}-mode cursor.`
      : null;
  const verifiedActive = isStatusVerifiedActive(authoritativeStatus);
  const canRestore =
    nativeEngineAvailable && isRestoreAvailable(authoritativeStatus);
  const restoreDisabled =
    operation !== "idle" || pendingPreferenceCount > 0 || !canRestore;
  const loginApprovalRequired = Boolean(
    nativeEngineAvailable && authoritativeStatus?.loginApprovalRequired,
  );

  const filteredPacks = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return packs;
    }
    return catalog.filterCursorCatalog(packs, query);
  }, [packs, search]);
  const onboardingFamilyJobs = useMemo(
    () =>
      onboarding.jobs
        .filter(isOnboardingJobVisible)
        .map((job) => {
          const representative = ONBOARDING_FAMILIES_BY_ID.get(job.familyId);
          if (!representative) {
            return null;
          }
          return {
            ...job,
            family: representative.family,
          };
        })
        .filter(Boolean),
    [onboarding.jobs],
  );

  const nativeSelection = packs.find(
    (pack) =>
      matchesCursorPack(pack, effectiveId) ||
      matchesCursorPack(pack, selectedStatusId),
  );
  const baseSelectedId = selectionWasChanged
    ? selectedId
    : (nativeSelection?.id ?? selectedId);
  const automaticSelectedId = getAutomaticSelectionId(
    filteredPacks,
    baseSelectedId,
  );
  const displayedSelectedId = automaticSelectedId ?? baseSelectedId;

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

  const selectedPack =
    packs.find((pack) => pack.id === displayedSelectedId) ??
    filteredPacks[0] ??
    packs[0] ??
    null;

  const handleSelect = useCallback((id) => {
    setSelectionWasChanged(true);
    setSelectedId(id);
    setFeedback(null);
  }, []);

  const handleSearchChange = useCallback((value) => {
    setSearch(value);
    setFeedback(null);
  }, []);

  const refreshStatus = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["cursor-status"] });
    return queryClient.fetchQuery({
      queryKey: ["cursor-status"],
      queryFn: readStatusSnapshot,
    });
  }, [queryClient, readStatusSnapshot]);

  const refreshLibraryQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["cursor-themes"] }),
      queryClient.invalidateQueries({ queryKey: ["cursor-preferences"] }),
      queryClient.invalidateQueries({ queryKey: ["cursor-status"] }),
    ]);
  }, [queryClient]);

  const handlePreferenceChange = useCallback(
    async (update) => {
      if (!preferencesAvailable) {
        setFeedback({
          scope: "preferences",
          type: "error",
          message: preferencesErrorMessage,
        });
        return false;
      }
      const previousPreferences = normalizeCursorPreferences(
        queryClient.getQueryData(["cursor-preferences"]),
      );
      const resolveEffectivePatch = (currentPreferences) => {
        const patch = resolveCursorPreferenceUpdate(update, currentPreferences);
        const requestedPreferences = mergeCursorPreferences(
          currentPreferences,
          patch,
        );
        const scheduleHasCompletePools = ["light", "dark"].every(
          (appearance) =>
            resolveRandomCursorPool(packs, requestedPreferences, appearance)
              .length > 0,
        );
        return engineAvailable &&
          requestedPreferences.randomization.automaticEnabled === true &&
          !scheduleHasCompletePools
          ? {
              ...patch,
              randomization: {
                ...(patch?.randomization ?? {}),
                automaticEnabled: false,
              },
            }
          : patch;
      };
      const effectivePatch = resolveEffectivePatch(previousPreferences);
      const optimisticPreferences = mergeCursorPreferences(
        previousPreferences,
        effectivePatch,
      );
      const entry = {
        id: ++preferenceRequestIdRef.current,
        update: resolveEffectivePatch,
      };
      pendingPreferenceUpdatesRef.current = [
        ...pendingPreferenceUpdatesRef.current,
        entry,
      ];
      setPendingPreferenceCount(pendingPreferenceUpdatesRef.current.length);
      setFeedback(null);
      queryClient.setQueryData(["cursor-preferences"], optimisticPreferences);

      let executionRevision = eventRevisionRef.current.preferences;
      const save = async () => {
        const authoritativePreferences =
          await readAuthoritativePreferencesSnapshot();
        const rebasedPatch = resolveEffectivePatch(authoritativePreferences);
        executionRevision = eventRevisionRef.current.preferences;
        const updated = await updateNativePreferences(rebasedPatch);
        authoritativePreferencesRef.current = updated;
        return updated;
      };
      const request = preferenceSaveQueueRef.current.then(save, save);
      preferenceSaveQueueRef.current = request.then(
        () => undefined,
        () => undefined,
      );

      const removePendingEntry = () => {
        pendingPreferenceUpdatesRef.current =
          pendingPreferenceUpdatesRef.current.filter(
            (candidate) => candidate.id !== entry.id,
          );
        setPendingPreferenceCount(pendingPreferenceUpdatesRef.current.length);
      };

      try {
        const updated = normalizeCursorPreferences(await request);
        removePendingEntry();
        if (executionRevision === eventRevisionRef.current.preferences) {
          const displayedPreferences = applyCursorPreferenceUpdates(
            updated,
            pendingPreferenceUpdatesRef.current,
          );
          queryClient.setQueryData(
            ["cursor-preferences"],
            displayedPreferences,
          );
        }
        return true;
      } catch (error) {
        removePendingEntry();
        const message = getCursorErrorMessage(error);
        let authoritativePreferences = authoritativePreferencesRef.current;
        try {
          authoritativePreferences =
            await readAuthoritativePreferencesSnapshot();
        } catch {
          // Preserve the last confirmed snapshot when reconciliation is also
          // unavailable; the inline error keeps the failure visible.
        }
        const displayedPreferences = applyCursorPreferenceUpdates(
          authoritativePreferences,
          pendingPreferenceUpdatesRef.current,
        );
        queryClient.setQueryData(["cursor-preferences"], displayedPreferences);
        setFeedback({
          scope: "preferences",
          type: "error",
          message,
        });
        return false;
      }
    },
    [
      engineAvailable,
      preferencesAvailable,
      preferencesErrorMessage,
      packs,
      queryClient,
      readAuthoritativePreferencesSnapshot,
    ],
  );

  useEffect(() => {
    if (!preferencesAvailable || !nativeThemeQuerySuccess || !engineAvailable) {
      return;
    }
    if (
      hasCompleteRandomizationPools ||
      preferences.randomization.automaticEnabled !== true
    ) {
      if (pendingPreferenceCount === 0) {
        scheduleCorrectionRef.current = null;
      }
      return;
    }
    if (pendingPreferenceCount > 0) {
      return;
    }
    const correctionKey = JSON.stringify({
      family: preferences.randomization.family,
      pools: preferences.randomization.pools,
      schedule: preferences.randomization.schedule,
      source: preferences.randomization.source,
    });
    if (scheduleCorrectionRef.current === correctionKey) {
      return;
    }
    const disableTimer = window.setTimeout(() => {
      scheduleCorrectionRef.current = correctionKey;
      void handlePreferenceChange({
        randomization: { automaticEnabled: false },
      });
    }, 0);
    return () => window.clearTimeout(disableTimer);
  }, [
    handlePreferenceChange,
    hasCompleteRandomizationPools,
    engineAvailable,
    nativeThemeQuerySuccess,
    pendingPreferenceCount,
    preferences.randomization,
    preferencesAvailable,
  ]);

  const handleToggleCursorFavorite = useCallback(
    (preferenceId, favorite) => {
      if (!preferenceId) {
        return;
      }
      void handlePreferenceChange((current) => {
        const cursorIds = new Set(current.favorites.cursorIds);
        if (favorite) {
          cursorIds.add(preferenceId);
        } else {
          cursorIds.delete(preferenceId);
        }
        return { favorites: { cursorIds: [...cursorIds] } };
      });
    },
    [handlePreferenceChange],
  );

  const handleToggleFamilyFavorite = useCallback(
    (family, favorite) => {
      if (!family) {
        return;
      }
      void handlePreferenceChange((current) => {
        const families = new Set(current.favorites.families);
        if (favorite) {
          families.add(family);
        } else {
          families.delete(family);
        }
        return { favorites: { families: [...families] } };
      });
    },
    [handlePreferenceChange],
  );

  const handleAssignAppearanceCursor = useCallback(
    async (preferenceId, appearance) => {
      if (
        !preferencesAvailable ||
        pendingPreferenceUpdatesRef.current.length > 0 ||
        !preferenceId ||
        (appearance !== "light" && appearance !== "dark")
      ) {
        return;
      }
      const targetPack = packs.find((candidate) =>
        matchesCursorPack(candidate, preferenceId),
      );
      if (!targetPack) {
        return;
      }
      const current = normalizeCursorPreferences(
        queryClient.getQueryData(["cursor-preferences"]),
      );
      const appearanceKey = `${appearance}CursorId`;
      const isClearing = current.appearance[appearanceKey] === preferenceId;
      if (!isClearing && (!engineAvailable || targetPack.canApply !== true)) {
        return;
      }
      const token = beginOperation(`assigning-${appearance}`, targetPack.id);
      if (!token) {
        return;
      }
      setFeedback(null);
      try {
        const nextPreferenceId = isClearing ? null : preferenceId;
        const result = await setNativeAppearanceCursor(
          appearance,
          nextPreferenceId,
        );
        if (result?.preferences) {
          const displayedPreferences = displayPendingPreferences(
            result.preferences,
          );
          queryClient.setQueryData(
            ["cursor-preferences"],
            displayedPreferences,
          );
        } else {
          await queryClient.invalidateQueries({
            queryKey: ["cursor-preferences"],
          });
        }
        if (result?.status) {
          queryClient.setQueryData(["cursor-status"], result.status);
        }
      } catch (error) {
        const message = getCursorErrorMessage(error);
        await Promise.allSettled([
          queryClient.invalidateQueries({
            queryKey: ["cursor-preferences"],
          }),
          refreshStatus(),
        ]);
        setFeedback({
          scope: "catalog",
          targetPackId: targetPack.id,
          type: "error",
          message,
        });
      } finally {
        endOperation(token);
      }
    },
    [
      beginOperation,
      displayPendingPreferences,
      endOperation,
      engineAvailable,
      packs,
      preferencesAvailable,
      queryClient,
      refreshStatus,
    ],
  );

  const handleToggleRandomizationRole = useCallback(
    (preferenceId, role, enabled) => {
      if (!preferenceId || (role !== "light" && role !== "dark")) {
        return;
      }
      void handlePreferenceChange((current) => {
        const cursorIds = new Set(current.randomization.pools[role]);
        if (enabled) {
          cursorIds.add(preferenceId);
        } else {
          cursorIds.delete(preferenceId);
        }
        return {
          randomization: {
            pools: { [role]: [...cursorIds] },
          },
        };
      });
    },
    [handlePreferenceChange],
  );

  const handleRandomize = useCallback(async () => {
    if (!canRandomize) {
      return;
    }
    const token = beginOperation("randomizing");
    if (!token) {
      return;
    }
    setFeedback(null);
    try {
      const result = await randomizeNativeCursor();
      if (!isRandomizationResultVerified(result)) {
        throw new Error(
          result
            ? "The randomized cursor could not be verified."
            : "Randomization was canceled because its settings changed.",
        );
      }
      const randomizedId =
        result?.cursor?.nativeThemeId ??
        result?.cursor?.id ??
        result?.nativeThemeId ??
        null;
      const randomizedPack = randomizedId
        ? packs.find((pack) => matchesCursorPack(pack, randomizedId))
        : null;
      if (randomizedPack) {
        setSelectionWasChanged(true);
        setSelectedId(randomizedPack.id);
      }
      queryClient.setQueryData(["cursor-status"], result.status);
      setFeedback({
        scope: "randomization",
        type: "success",
        message: randomizedPack
          ? `${randomizedPack.family} ${randomizedPack.variant} is active.`
          : "A new random cursor is active.",
      });
    } catch (error) {
      const message = getCursorErrorMessage(error);
      await Promise.allSettled([
        refreshStatus(),
        queryClient.invalidateQueries({
          queryKey: ["cursor-preferences"],
        }),
      ]);
      setFeedback({
        scope: "randomization",
        type: "error",
        message,
      });
    } finally {
      endOperation(token);
    }
  }, [
    beginOperation,
    endOperation,
    canRandomize,
    packs,
    queryClient,
    refreshStatus,
  ]);

  const handleApply = useCallback(async () => {
    if (!engineAvailable || !selectedPack || selectedPack.canApply !== true) {
      return;
    }
    const targetPack = selectedPack;
    const token = beginOperation("applying", targetPack.id);
    if (!token) {
      return;
    }
    setFeedback(null);
    try {
      const nextStatus = await applyCursorTheme(
        targetPack.nativeThemeId ?? targetPack.id,
      );
      if (!isPackVerifiedActive(nextStatus, targetPack)) {
        throw new Error(`${targetPack.variant} could not be verified.`);
      }
      queryClient.setQueryData(["cursor-status"], nextStatus);
      setFeedback({
        scope: "catalog",
        targetPackId: targetPack.id,
        type: "success",
        message: `${targetPack.variant} is active.`,
      });
    } catch (error) {
      try {
        await refreshStatus();
      } catch {
        // Keep the apply error; the status query retains its prior data.
      }
      setFeedback({
        scope: "catalog",
        targetPackId: targetPack.id,
        type: "error",
        message: getCursorErrorMessage(error),
      });
    } finally {
      endOperation(token);
    }
  }, [
    beginOperation,
    endOperation,
    engineAvailable,
    queryClient,
    refreshStatus,
    selectedPack,
  ]);

  const handleSizeCommit = useCallback(
    async (sizePercentage) => {
      if (!engineAvailable || !selectedPack || selectedPack.canApply !== true) {
        throw new Error("Cursor size customization is unavailable.");
      }
      const targetPack = selectedPack;
      const token = beginOperation("sizing", targetPack.id);
      if (!token) {
        throw new Error("Another cursor operation is already in progress.");
      }
      setFeedback(null);
      try {
        const activeSizeTarget = Boolean(
          verifiedActive && matchesCursorPack(targetPack, effectiveId),
        );
        const result = await setCursorThemeSize(
          targetPack.nativeThemeId ?? targetPack.id,
          sizePercentage,
        );
        queryClient.setQueryData(["cursor-themes"], (themes) =>
          Array.isArray(themes)
            ? themes.map((theme) =>
                matchesCursorPack(theme, result.nativeThemeId)
                  ? {
                      ...theme,
                      sizePercentage: result.sizePercentage,
                    }
                  : theme,
              )
            : themes,
        );
        setFeedback({
          scope: "catalog",
          targetPackId: targetPack.id,
          type: "success",
          message: activeSizeTarget
            ? "Size saved. Reapply to update the active cursor."
            : "Size saved.",
        });
        return result;
      } catch (error) {
        const message = getCursorErrorMessage(error);
        await Promise.allSettled([
          queryClient.invalidateQueries({ queryKey: ["cursor-themes"] }),
        ]);
        setFeedback({
          scope: "catalog",
          targetPackId: targetPack.id,
          type: "error",
          message,
        });
        throw error;
      } finally {
        endOperation(token);
      }
    },
    [
      beginOperation,
      effectiveId,
      endOperation,
      engineAvailable,
      queryClient,
      selectedPack,
      verifiedActive,
    ],
  );

  const handleRestore = useCallback(async () => {
    if (!canRestore) {
      return;
    }
    const token = beginOperation("restoring");
    if (!token) {
      return;
    }
    setFeedback(null);
    try {
      const result = await restoreCursorState();
      const nextStatus = result?.status;
      if (!isStatusVerifiedRestored(nextStatus)) {
        throw new Error("The system cursor restore could not be verified.");
      }
      queryClient.setQueryData(["cursor-status"], nextStatus);
      if (result?.preferences) {
        const displayedPreferences = displayPendingPreferences(
          result.preferences,
        );
        queryClient.setQueryData(["cursor-preferences"], displayedPreferences);
      } else {
        await queryClient.invalidateQueries({
          queryKey: ["cursor-preferences"],
        });
      }
      setFeedback({
        scope: "catalog",
        type: "success",
        message: "System cursor restored.",
      });
    } catch (error) {
      const message = getCursorErrorMessage(error);
      await Promise.allSettled([
        refreshStatus(),
        queryClient.invalidateQueries({
          queryKey: ["cursor-preferences"],
        }),
      ]);
      setFeedback({
        scope: "catalog",
        type: "error",
        message,
      });
    } finally {
      endOperation(token);
    }
  }, [
    beginOperation,
    canRestore,
    displayPendingPreferences,
    endOperation,
    queryClient,
    refreshStatus,
  ]);

  const handleImport = useCallback(
    async (options) => {
      const token = beginOperation("importing");
      if (!token) {
        return;
      }
      setFeedback(null);
      try {
        const result = await importCursorPack(options);
        if (result?.canceled) {
          return;
        }

        await queryClient.invalidateQueries({ queryKey: ["cursor-themes"] });
        const nextThemes = await queryClient.fetchQuery({
          queryKey: ["cursor-themes"],
          queryFn: readThemesSnapshot,
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
          setSelectionWasChanged(true);
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
        const message = getCursorErrorMessage(error);
        await Promise.allSettled([refreshLibraryQueries()]);
        setFeedback({
          scope: "catalog",
          type: "error",
          message,
        });
      } finally {
        endOperation(token);
      }
    },
    [
      beginOperation,
      endOperation,
      queryClient,
      readThemesSnapshot,
      refreshLibraryQueries,
    ],
  );

  const handleAssignFamily = useCallback(
    async (pack, family) => {
      const identifier = pack?.nativeThemeId ?? pack?.id;
      if (!identifier || pack?.imported !== true) {
        return {
          ok: false,
          message: "Only imported cursors can be organized.",
        };
      }
      const token = beginOperation("organizing");
      if (!token) {
        return {
          ok: false,
          message: "Another cursor operation is already in progress.",
        };
      }
      setFeedback({
        scope: "catalog",
        type: "pending",
        message: `Moving ${pack.variant}…`,
      });
      try {
        const result = await assignImportedCursorFamily([identifier], family);
        await refreshLibraryQueries();
        const assignedFamily = result?.family ?? String(family).trim();
        const cleanupPending = Boolean(result?.preferenceCleanupPending);
        setFeedback({
          scope: "catalog",
          type: "success",
          message: cleanupPending
            ? `${pack.variant} moved to ${assignedFamily}; some saved cursor settings still need cleanup.`
            : `${pack.variant} moved to ${assignedFamily}.`,
        });
        return { ok: true, family: assignedFamily };
      } catch (error) {
        const message = getCursorErrorMessage(error);
        await Promise.allSettled([refreshLibraryQueries()]);
        setFeedback({ scope: "catalog", type: "error", message });
        return { ok: false, message };
      } finally {
        endOperation(token);
      }
    },
    [beginOperation, endOperation, refreshLibraryQueries],
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
    const importedPacks = (familyPacks ?? []).filter(
      (pack) => pack.imported === true,
    );
    if (!family || !importedPacks.length) {
      return;
    }
    setDeleteTarget({
      kind: "family",
      label: family,
      family,
      identifiers: importedPacks.map((pack) => pack.nativeThemeId ?? pack.id),
      count: importedPacks.length,
    });
  }, []);

  const handleDeleteConfirmed = useCallback(async () => {
    const target = deleteTarget;
    if (!target) {
      return;
    }
    const token = beginOperation("deleting");
    if (!token) {
      return;
    }
    setFeedback(null);
    try {
      const result =
        target.kind === "family"
          ? await deleteImportedCursorFamily(target.family)
          : await deleteImportedCursor(target.identifier);
      const removedIds = new Set(
        target.identifiers.map((identifier) => identifier.toLowerCase()),
      );
      const currentSelectedPack = selectedPack;
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
        setSelectionWasChanged(true);
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
      setDeleteTarget(null);
    } catch (error) {
      const message = getCursorErrorMessage(error);
      await Promise.allSettled([refreshLibraryQueries()]);
      setFeedback({
        scope: "catalog",
        type: "error",
        message,
      });
      setDeleteTarget(null);
    } finally {
      endOperation(token);
    }
  }, [
    beginOperation,
    deleteTarget,
    endOperation,
    packs,
    refreshLibraryQueries,
    selectedPack,
  ]);

  const handleOpenLoginSettings = useCallback(async () => {
    const token = beginOperation("opening-settings");
    if (!token) {
      return;
    }
    setFeedback(null);
    try {
      await openLoginItemsSettings();
    } catch (error) {
      setFeedback({
        scope: "catalog",
        type: "error",
        message: getCursorErrorMessage(error),
      });
    } finally {
      endOperation(token);
    }
  }, [beginOperation, endOperation]);

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
    ? getAssignedAppearanceModes(preferences, selectedPreferenceId)
    : [];
  const selectedRandomizationRoles = selectedPreferenceId
    ? ["light", "dark"].filter((role) =>
        preferences.randomization.pools[role].includes(selectedPreferenceId),
      )
    : [];
  const familyNames = useMemo(
    () =>
      [...new Set(packs.map((pack) => pack.family).filter(Boolean))].sort(
        (left, right) => left.localeCompare(right),
      ),
    [packs],
  );
  const addingFamilyNames = useMemo(
    () =>
      new Set(
        onboardingFamilyJobs
          .filter((job) => job.status !== "failed")
          .map((job) => job.family.toLocaleLowerCase()),
      ),
    [onboardingFamilyJobs],
  );
  const addingCursorPacks = onboardingFamilyJobs.some(
    (job) => job.status !== "failed",
  );
  const libraryActions = useMemo(
    () => ({
      familyNames,
      operationDisabled: operation !== "idle",
      managementDisabled: (family) =>
        isCursorFamilyManagementDisabled({
          family,
          operation,
          pendingPreferenceCount,
          addingFamilyNames,
        }),
      preferencesSaving: pendingPreferenceCount > 0,
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
      addingFamilyNames,
      familyNames,
      operation,
      pendingPreferenceCount,
    ],
  );

  if (onboardingLoading || onboarding.completed === null) {
    return (
      <main className="h-dvh w-full overflow-hidden bg-background">
        <div className="titlebar-drag h-12" />
      </main>
    );
  }

  if (!onboarding.completed) {
    return (
      <OnboardingScreen
        families={ONBOARDING_FAMILIES}
        onContinue={(familyIds) => {
          void completeOnboarding(familyIds);
        }}
      />
    );
  }

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background">
      {view === "catalog" ? (
        <header
          className={cn(
            "titlebar-drag flex h-12 shrink-0 items-center justify-end border-b border-border/60 pr-3 sm:pr-4",
            isLinux ? "pl-3" : "pl-[78px]",
          )}
        >
          <div className="titlebar-no-drag flex shrink-0 items-center gap-2">
            <TooltipProvider>
              <div className="flex items-center gap-0.5">
                <ImportButton
                  onImport={handleImport}
                  disabled={operation !== "idle" || pendingPreferenceCount > 0}
                  importing={operation === "importing"}
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-disabled={restoreDisabled}
                        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                        onClick={() => {
                          if (!restoreDisabled) {
                            void handleRestore();
                          }
                        }}
                      />
                    }
                  >
                    <HugeiconsIcon
                      icon={ArrowReloadHorizontalIcon}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    {operation === "restoring" ? "Restoring…" : "Restore"}
                  </TooltipTrigger>
                  <TooltipContent>
                    Restore the cursor your desktop was using before Cursor
                    Atelier
                  </TooltipContent>
                </Tooltip>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRandomize()}
                  disabled={
                    !canRandomize ||
                    operation !== "idle" ||
                    pendingPreferenceCount > 0
                  }
                >
                  <HugeiconsIcon
                    icon={ShuffleIcon}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  {operation === "randomizing" ? "Randomizing…" : "Randomize"}
                </Button>
              </div>
            </TooltipProvider>
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
                  <div
                    className="titlebar-drag h-12 shrink-0"
                    aria-hidden="true"
                  />
                  <SheetHeader className="sr-only">
                    <SheetTitle>Choose a cursor pack</SheetTitle>
                    <SheetDescription>Choose a cursor pack.</SheetDescription>
                  </SheetHeader>
                  <PackRail
                    packs={filteredPacks}
                    allPacks={packs}
                    selectedId={displayedSelectedId}
                    effectiveId={effectiveId}
                    verifiedActive={verifiedActive}
                    engineAvailable={engineAvailable}
                    preferencesAvailable={preferencesAvailable}
                    preferences={preferences}
                    search={search}
                    onSearch={handleSearchChange}
                    onSelect={handleSelect}
                    onClearSearch={() => handleSearchChange("")}
                    onToggleCursorFavorite={handleToggleCursorFavorite}
                    onToggleFamilyFavorite={handleToggleFamilyFavorite}
                    onAssignAppearanceCursor={handleAssignAppearanceCursor}
                    libraryActions={libraryActions}
                    familyJobs={onboardingFamilyJobs}
                    onRetryFamily={(familyId) =>
                      void retryOnboardingImport(familyId)
                    }
                    loadError={catalogueLoadError}
                    loading={initialCursorDataLoading}
                    onClose={() => setRailOpen(false)}
                  />
                </SheetContent>
              </Sheet>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Settings"
              onClick={() => {
                setFeedback(null);
                setView("settings");
              }}
            >
              <HugeiconsIcon
                icon={Settings02Icon}
                strokeWidth={2}
                aria-hidden="true"
              />
            </Button>
          </div>
        </header>
      ) : null}

      {view === "settings" ? (
        <SettingsScreen
          packs={catalogueLoadError ? [] : packs}
          preferences={preferences}
          appearanceMode={themeMode}
          onAppearanceModeChange={setThemeMode}
          onChange={handlePreferenceChange}
          onRandomize={() => void handleRandomize()}
          randomizing={operation === "randomizing"}
          cursorOperationBusy={operation !== "idle"}
          saving={pendingPreferenceCount > 0}
          canRandomize={canRandomize}
          canScheduleRandomization={canScheduleRandomization}
          scheduleUnavailableMessage={scheduleUnavailableMessage}
          randomizationAvailable={engineAvailable}
          randomizationPoolSize={randomizationPoolSizes[systemAppearance]}
          systemAppearance={systemAppearance}
          preferencesAvailable={preferencesAvailable}
          preferencesError={preferencesQuery.isError}
          preferencesErrorMessage={preferencesErrorMessage}
          preferencesRetrying={preferencesQuery.isFetching}
          onRetryPreferences={() => void preferencesQuery.refetch()}
          themeError={themeError}
          feedback={feedback}
          onClose={() => setView("catalog")}
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <aside className="hidden min-h-0 min-w-0 w-[276px] shrink-0 overflow-hidden border-r border-border/60 bg-sidebar/45 min-[960px]:flex lg:w-[296px]">
            <PackRail
              packs={filteredPacks}
              allPacks={packs}
              selectedId={displayedSelectedId}
              effectiveId={effectiveId}
              verifiedActive={verifiedActive}
              engineAvailable={engineAvailable}
              preferencesAvailable={preferencesAvailable}
              preferences={preferences}
              search={search}
              onSearch={handleSearchChange}
              onSelect={handleSelect}
              onClearSearch={() => handleSearchChange("")}
              onToggleCursorFavorite={handleToggleCursorFavorite}
              onToggleFamilyFavorite={handleToggleFamilyFavorite}
              onAssignAppearanceCursor={handleAssignAppearanceCursor}
              libraryActions={libraryActions}
              familyJobs={onboardingFamilyJobs}
              onRetryFamily={(familyId) => void retryOnboardingImport(familyId)}
              loadError={catalogueLoadError}
              loading={initialCursorDataLoading}
            />
          </aside>
          {catalogueLoadError ? (
            <CatalogueFailure
              onRetry={() => void nativeThemesQuery.refetch()}
              retrying={nativeThemesQuery.isFetching}
            />
          ) : initialCursorDataLoading ? (
            <EmptyLibrary loading />
          ) : selectedPack ? (
            <PackDetails
              key={selectedPack.id}
              pack={selectedPack}
              active={active}
              favorite={selectedFavorite}
              appearanceRoles={selectedAppearanceRoles}
              randomizationRoles={selectedRandomizationRoles}
              selectedBySystem={selectedBySystem}
              operation={operation}
              operationTargetPackId={operationTargetPackId}
              preferencesSaving={pendingPreferenceCount > 0}
              onApply={() => void handleApply()}
              onSizeCommit={handleSizeCommit}
              onToggleFavorite={() =>
                handleToggleCursorFavorite(
                  selectedPreferenceId,
                  !selectedFavorite,
                )
              }
              onAssignAppearanceCursor={(role) =>
                void handleAssignAppearanceCursor(selectedPreferenceId, role)
              }
              onToggleRandomizationRole={(role) =>
                handleToggleRandomizationRole(
                  selectedPreferenceId,
                  role,
                  !selectedRandomizationRoles.includes(role),
                )
              }
              onOpenLoginSettings={handleOpenLoginSettings}
              feedback={feedback}
              engineAvailable={engineAvailable}
              preferencesAvailable={preferencesAvailable}
              preferencesError={preferencesQuery.isError}
              preferencesErrorMessage={preferencesErrorMessage}
              onRetryPreferences={() => void preferencesQuery.refetch()}
              preferencesRetrying={preferencesQuery.isFetching}
              loginApprovalRequired={loginApprovalRequired}
              statusError={statusUnavailable}
              statusErrorMessage={statusErrorMessage}
              onRetryStatus={() => void statusQuery.refetch()}
              statusRetrying={statusQuery.isFetching}
            />
          ) : (
            <EmptyLibrary adding={addingCursorPacks} />
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
          if (!open && operationRef.current?.kind !== "deleting") {
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
            <AlertDialogCancel disabled={operation === "deleting"}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={operation === "deleting"}
              onClick={() => void handleDeleteConfirmed()}
            >
              {operation === "deleting" ? "Moving…" : "Move to Trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
