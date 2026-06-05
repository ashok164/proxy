# Change Handoff

## Summary

This backend was updated to fix a PostgreSQL startup migration error and to make realtime tournament slug handling consistent across HTTP and WebSocket routes.

## 1. Database Migration Fix

### Problem

Startup failed with:

```text
cannot drop constraint teams_team_id_key on table teams because other objects depend on it
```

The app is migrating from a global unique constraint on `teams.team_id` to tournament-scoped uniqueness on `(tournament_id, team_id)`. PostgreSQL refused to drop the old `teams_team_id_key` constraint because dependent objects, usually foreign keys tied to the backing unique index, still existed.

### Files Changed

- `Database/schemaMigrations.js`
- `Database/initDB.js`
- `Routes/teamRecord.js`

### What Changed

Added `Database/schemaMigrations.js` with:

```js
dropConstraintWithDependents(pool, tableName, constraintName)
```

This helper:

- Finds constraints depending on the target constraint or its backing index.
- Drops those dependent constraints first.
- Drops the target constraint afterward.

Then replaced direct calls like:

```sql
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_team_id_key
```

with:

```js
await dropConstraintWithDependents(pool, "teams", "teams_team_id_key");
```

This is used in both startup migration and team table scope checks.

## 2. Tournament-Aware Realtime Fix

### Problem

Tournament scoping existed in many routes through `getTournamentIdFromRequest()`, but realtime behavior was incomplete:

- HTTP realtime routes accepted slug only through query/header, not path.
- WebSocket routes did not resolve tournament slug.
- The central realtime engine called `buildStandings(matchId, logoCache)` without `tournamentId`.
- Realtime cache was keyed only by `matchId`, so different tournaments using the same match id could share/cross-contaminate cached data.

### Files Changed

- `Routes/realtime.js`
- `server.js`

### What Changed

Added tournament-aware realtime cache keys:

```js
const getMatchCacheKey = (matchId, tournamentId = null) =>
  `${tournamentId || "default"}:${matchId}`;
```

Updated `startCentralEngine()` to accept `tournamentId` and call:

```js
buildStandings(matchId, entry.logoCache, tournamentId);
```

Updated HTTP realtime route paths to support slug-prefixed URLs:

```text
/ws/realtime/:matchId
/realtime/:matchId
/tablestandings/:matchId
/:tournamentSlug/ws/realtime/:matchId
/:tournamentSlug/realtime/:matchId
/:tournamentSlug/tablestandings/:matchId
```

Updated WebSocket parsing to support:

```text
/realtime/:matchId
/tablestandings/:matchId
/:tournamentSlug/realtime/:matchId
/:tournamentSlug/tablestandings/:matchId
/:tournamentSlug/ws/realtime/:matchId
```

WebSocket requests now also parse query params, so this works:

```text
/ws/realtime/MATCH_ID?slug=my-tournament
```

Updated `server.js` WebSocket upgrade handler to `await` the now-async realtime WebSocket handler.

## Supported Tournament Slug Inputs

Tournament slug can come from:

```text
/:tournamentSlug/...
?slug=...
?tournament=...
?tournamentSlug=...
x-tournament-slug header
```

Examples:

```text
/tablestandings/MATCH_ID?slug=my-tournament
/my-tournament/tablestandings/MATCH_ID
/realtime/MATCH_ID?slug=my-tournament
/my-tournament/realtime/MATCH_ID
/ws/realtime/MATCH_ID?slug=my-tournament
/my-tournament/ws/realtime/MATCH_ID
```

## Verification Performed

Syntax checks passed:

```bash
node --check Database\schemaMigrations.js
node --check Database\initDB.js
node --check Routes\teamRecord.js
node --check Routes\realtime.js
node --check server.js
```

The startup migration was retried after the database fix. The original `teams_team_id_key` error disappeared. The remaining startup issue was:

```text
listen EADDRINUSE: address already in use 0.0.0.0:3000
```

That means another server process was already using port `3000`.

## Notes For Next AI/Developer

- There are many existing unrelated modified files in the working tree. Do not revert them blindly.
- `Data/tournamentContext.js` is the central tournament resolver.
- `Routes/realtime.js` now scopes cache by `tournamentId + matchId`; any future realtime cache access should use `getMatchCacheKey()`.
- The app still defaults to the `saggu-family` tournament if no slug is provided.

## 3. Frontend Tournament Navigation Update

### Frontend Location

The UI project is:

```text
C:\Users\SARTHAK\Downloads\tournament_system_v2\client
```

### Existing UI State Before Latest Patch

The frontend already had:

- `client/src/Tournaments/View/TournamentManagerView.tsx`
- `client/src/Tournaments/tournamentState.ts`
- `client/src/Tournaments/Repository/remote.tsx`
- `client/src/Routes/BrowserRoute/browserRoutes.tsx`
- `client/src/Routes/RouteNavigator/RouteNavigator.tsx`

It already supported tournament creation, tournament selection, scoped paths like:

```text
/tournaments/:tournamentSlug/routes
/tournaments/:tournamentSlug/team-record
```

and Axios already sends:

```text
X-Tournament-Slug: selected-slug
```

### Latest UI Changes

Updated `client/src/Tournaments/tournamentState.ts`:

- Added `SELECTED_TOURNAMENT_NAME_KEY`.
- Added `getSelectedTournamentName()`.
- Added `setSelectedTournamentName()`.
- Added `setSelectedTournament(slug, name)`.

Updated `client/src/Tournaments/View/TournamentManagerView.tsx`:

- Tournament cards are now clickable entry cards.
- Pressing `Enter` or `Space` on a focused card also opens that tournament.
- Selecting or creating a tournament stores both slug and display name.
- Clicking a tournament navigates to:

```text
/tournaments/:slug/routes
```

Updated `client/src/Routes/BrowserRoute/browserRoutes.tsx`:

- Protected tournament pages now show breadcrumbs in the admin top shell.
- Breadcrumb format:

```text
Tournaments / Tournament Name / Current Page
```

- The shell still routes back to the selected tournament's Route Arena.

Updated `client/src/Routes/RouteNavigator/RouteNavigator.tsx`:

- Route Arena now shows the selected tournament display name as the main title.
- It also shows a local breadcrumb row:

```text
Tournaments / Tournament Name / Routes
```

- Route links continue to use tournament-scoped URLs via `getTournamentPath()`.

### Verification

Frontend TypeScript check passed:

```bash
cd C:\Users\SARTHAK\Downloads\tournament_system_v2\client
npx tsc --noEmit
```

## 4. Local Login 404 Fix

### Problem

Login for:

```text
jhuseesports164@gmail.com
```

looked like it was "not found" when the frontend used:

```text
http://localhost:3000
```

The user exists in the local PostgreSQL DB:

```text
id=1, role=super_admin, is_active=true
```

Direct login succeeded against:

```text
http://127.0.0.1:3000/api/auth/login
```

but `localhost:3000/api/auth/login` returned `404`. On this machine, there were two Node listeners on port `3000`, including an IPv6 `::1` listener, so `localhost` could hit the wrong process.

### Frontend Change

Updated:

```text
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\Routes\ApiRoutes\apiRoutes.tsx
```

from:

```ts
export const API_BASE_URL = "http://localhost:3000";
```

to:

```ts
export const API_BASE_URL = "http://127.0.0.1:3000";
```

### Verification

Direct backend login returned `200` with token and the `super_admin` user when using `127.0.0.1`.

Frontend TypeScript check passed again:

```bash
cd C:\Users\SARTHAK\Downloads\tournament_system_v2\client
npx tsc --noEmit
```

## 5. Tournament Edit/Delete Support

### Backend

Updated:

```text
C:\Users\SARTHAK\Desktop\proxy\Routes\auth.js
```

Added:

```text
PATCH /api/auth/tournaments/:id
DELETE /api/auth/tournaments/:id
```

`PATCH` supports updating:

```text
name
slug
domain
isActive / is_active
```

`DELETE` is a soft delete. It sets:

```text
is_active = false
```

so tournament-scoped data is not physically removed.

Both endpoints require `admin` or `super_admin` via `requireAdmin()`.

### Frontend

Updated:

```text
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\Routes\ApiRoutes\apiRoutes.tsx
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\Tournaments\Repository\remote.tsx
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\Tournaments\View\TournamentManagerView.tsx
```

Added frontend helpers:

```ts
updateTournamentApi(id, payload)
deleteTournamentApi(id)
```

Tournament cards now include:

```text
Open Tournament
Edit
Delete
```

Edit mode supports inline editing of:

```text
name
slug
domain
```

Delete asks for browser confirmation and then soft-deletes the tournament.

### Frontend Page Split

The tournament management UI was split into separate pages:

```text
/tournaments
/create-tournament
/roles
```

Scoped variants are also generated by the existing router:

```text
/tournaments/:tournamentSlug/tournaments
/tournaments/:tournamentSlug/create-tournament
/tournaments/:tournamentSlug/roles
```

Route purpose:

- `/tournaments`: list/open/edit/delete tournaments.
- `/create-tournament`: create a tournament only.
- `/roles`: manage user system roles and tournament access roles.

Route Arena now includes separate chips for:

```text
Tournaments
Roles
```

## 6. Tournament List Plus Dialog And Roles UI Polish

### Frontend Flow

Updated:

```text
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\Tournaments\View\TournamentManagerView.tsx
```

Login already redirects to:

```text
/tournaments
```

The `/tournaments` page now keeps tournament creation on the tournament list page:

- Header has a circular `+` button.
- Pressing `+` opens a modal dialog wrapper.
- The dialog contains the create tournament form.
- Saving creates the tournament, closes the dialog, refreshes the card list, and selects the new tournament.
- Tournament cards remain the main entry point into each tournament's route arena.

### Roles Page Polish

The `/roles` page was adjusted from a cramped control row into a clearer access layout:

- Role page has an explanatory subtitle under `User Access`.
- Super/admin users see refresh and full editable controls.
- Non-admin users only see their own role and tournament access in read-only chips.
- Role rows now have a table-like header:

```text
User / System / Status / Tournament Access / Actions
```

### Verification

Frontend TypeScript check passed:

```bash
cd C:\Users\SARTHAK\Downloads\tournament_system_v2\client
npx tsc --noEmit
```

### Role Behavior Notes

Current backend role behavior:

- `super_admin`: can see all active tournaments, create tournaments, update tournaments, delete tournaments, list users, update user roles, and assign users to tournaments.
- `admin`: currently has the same broad backend permissions as `super_admin` for these auth/tournament endpoints.
- `user`: can only see active tournaments assigned through `tournament_users`; cannot create tournaments, edit/delete tournaments, list users, change roles, or assign tournament access.

Tournament access roles are separate from system roles:

```text
owner
editor
viewer
```

They are stored in `tournament_users.role` and shown on tournament cards.

### Verification

Backend syntax:

```bash
node --check Routes\auth.js
```

Frontend TypeScript:

```bash
cd C:\Users\SARTHAK\Downloads\tournament_system_v2\client
npx tsc --noEmit
```

## 7. Removed Standalone Create Tournament Route

### Frontend

Updated:

```text
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\Routes\RouteNavigator\RouteNavigator.tsx
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\Routes\BrowserRoute\routeDefinitions.tsx
```

The Route Arena no longer shows `Create Tournament` inside the `Game Assets` group, and `/create-tournament` was removed from the route definitions.

Tournament creation now happens only from the tournament list page:

```text
/tournaments
```

Use the circular `+` button there to open the create tournament dialog.

### Game Assets Scope Note

Current game asset APIs are tournament-scoped, not global:

- Create inserts `tournament_id`.
- List reads `WHERE tournament_id = $1`.
- Update/delete require `id` and the same `tournament_id`.

Relevant backend file:

```text
C:\Users\SARTHAK\Desktop\proxy\Routes\gameAssets.js
```

That means assets uploaded in one tournament do not automatically appear in another tournament. Older pre-tournament data was migrated into the default/SAGGU FAMILY tournament by startup migration.

## 8. Pull Tournament Assets Switch

### Backend

Updated:

```text
C:\Users\SARTHAK\Desktop\proxy\Data\tournamentContext.js
C:\Users\SARTHAK\Desktop\proxy\Database\initDB.js
C:\Users\SARTHAK\Desktop\proxy\Routes\auth.js
C:\Users\SARTHAK\Desktop\proxy\Routes\gameAssets.js
```

Added a tournament setting:

```text
tournaments.pull_tournament_assets BOOLEAN NOT NULL DEFAULT false
```

The auth tournament APIs now create, update, and return this field as:

```text
pullTournamentAssets
```

When `pullTournamentAssets` is enabled for the selected tournament, `Routes/gameAssets.js` list endpoints include asset rows from all active tournaments. Rows from another tournament are returned with:

```text
is_shared: true
read_only: true
source_tournament_name
source_tournament_slug
```

Create still inserts into the selected/current tournament only. Update/delete still query by `id` and current `tournament_id`, so shared pulled rows cannot be modified through the borrowing tournament.

### Frontend

Updated:

```text
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\Tournaments\Repository\remote.tsx
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\Tournaments\View\TournamentManagerView.tsx
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\GameAssetUpload\Repository\remote.tsx
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\GameAssetUpload\Components\AssetUploadSection.tsx
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\TournamentAssets\Repository\remote.tsx
C:\Users\SARTHAK\Downloads\tournament_system_v2\client\src\TournamentAssets\View\TournamentAssetsView.tsx
```

Tournament create/edit now has a `Pull tournament assets` switch.

Tournament cards show:

```text
Pull shared assets
Own assets only
```

Game asset upload rows and Tournament Assets cards now treat pulled/shared rows as read-only:

- Inputs are disabled.
- Save/update is disabled.
- Delete is disabled.
- Rows show a shared/source label when available.

Delete buttons in these asset UIs are only visible for users whose stored system role is:

```text
admin
super_admin
```

Tournament delete was already backend-protected by `requireAdmin()` and is now also hidden in the tournament list UI for non-admin users.

### Verification

Backend syntax:

```bash
node --check Data\tournamentContext.js
node --check Database\initDB.js
node --check Routes\auth.js
node --check Routes\gameAssets.js
```

Frontend TypeScript:

```bash
cd C:\Users\SARTHAK\Downloads\tournament_system_v2\client
npx tsc --noEmit
```
