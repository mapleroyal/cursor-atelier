# Cursor Atelier feature tracker

This document tracks the cursor organization and automation work requested on
August 6, 2026. A checked item is implemented and verified; an unchecked item
still needs work or verification.

## Window and navigation

- [x] Collapse cursor families by default and make every family expandable.
- [x] Show an active indicator on a collapsed family when it contains the
      currently applied cursor.
- [x] Put the currently applied cursor at the top of the left rail.
- [x] Show favorited cursor packs and families below the current cursor, then
      separate those shortcuts from the full family list.
- [x] Increase the selected-row rail marker from 2 px to 6 px.
- [x] Remove the cursor glyph from the title bar and center “Cursor Atelier”.
- [x] Replace the generic system-appearance glyph with the computer/device
      glyph used by the source design in `markdown-reader-editor`.

## Favorites and appearance roles

- [x] Favorite or unfavorite a cursor from its rail context menu.
- [x] Favorite or unfavorite a cursor with the heart beside Apply.
- [x] Favorite or unfavorite a family from its rail context menu.
- [x] Mark a cursor for light mode, dark mode, both, or neither.
- [x] Persist favorites and appearance roles.

Favorites are independent and additive. Favoriting a family does not silently
fill every variant's heart. For selection and randomization, a favorited family
contributes all of its current variants, direct cursor favorites contribute
only themselves, and the combined pool is deduplicated. This keeps both actions
reversible and prevents a family-level choice from destroying item-level intent.

## Settings and appearance-aware cursors

- [x] Add a focused Settings screen now that persistent behavior exists.
- [x] Allow a fixed cursor choice for macOS light mode and another for dark
      mode.
- [x] Apply the relevant configured cursor when macOS appearance changes.
- [x] Allow the menu-bar item to be shown or hidden.
- [x] Keep the settings surface limited to behavior required by these features.

## Randomization

- [x] Randomize from all available cursors, favorites, or one family.
- [x] When appearance-aware behavior is enabled, filter random favorites to the
      cursor roles for the current macOS appearance.
- [x] Support every _x_ hours, including quarter-hour decimal increments.
- [x] Support one or more specific times each day.
- [x] Support once at app launch.
- [x] Support once daily at a specified time.
- [x] Avoid immediately reselecting the current cursor when another eligible
      cursor exists.
- [x] Persist the schedule and restore it on launch.

## Menu bar

- [x] Add a macOS menu-bar item.
- [x] Provide Open Cursor Atelier, Settings, New Random Cursor, the current
      cursor, show/hide behavior, and Quit.
- [x] Make New Random Cursor use the same source and appearance filters as the
      configured schedule.

## Verification

- [x] Unit-test preference validation, favorite-pool resolution, and schedule
      calculations.
- [x] Run the existing unit and lint suites.
- [x] Package the app and smoke-test the packaged build where the local signing
      environment permits it.
