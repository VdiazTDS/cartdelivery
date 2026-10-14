# Delivery profiles: deployment and operation

The app uses Supabase Auth, PostgreSQL and Storage. Excel is an immutable import/export source. Saves and sync commit database records; the Edge Function never loads SheetJS or workbook bytes.

## Current deployment

Project: `lffazhbwvorwxineklsy` (`VdiazTDS's Project`). All ten migrations, through `202610140001_team_file_deletion.sql`, are installed; **do not run them again**. Email/password signup is enabled, email confirmation is disabled for username aliases, and passwords require six characters with no additional composition rules.

**Team-file deletion deployed October 14, 2026:** [202610140001_team_file_deletion.sql](migrations/202610140001_team_file_deletion.sql) is installed and `profile-workbooks` is ACTIVE at version 8 with the **Confirm** keyword requirement. The function bundles `index.ts`, `data-service.mjs` and `admin-service.mjs`. Publish the matching `index.html`, `app.js` and `style.css` together; the frontend changes are still in the workspace. Do not reapply the migration.

Live checks verified the service-only deletion RPC/table permissions, a deletion preview inside an explicitly read-only transaction, public listing of both team files, and rejection of missing/invalid authentication for both deletion actions. The two team files, three profile copies, 10,728 records, 1,946 drafts, 3,682 versions, two history events, two work-area snapshots and 46 storage objects were preserved. Eight new copy-operation receipts appeared during the deployment window; the migration does not write receipts, and all other counts were unchanged. Phone/desktop tests in both themes and backend deletion/retry tests used local sample data and intercepted storage. No production deletion was performed.

Any active signed-in profile may delete a team Excel from Cart Delivery; administrator privileges and file ownership are not required. The user types **Confirm** and gives explicit acknowledgement. The server checks that word and independently verifies the selected file?s name and stable ID. The confirmation lists all affected profile copies, pending stop changes, shared records, versions, history, areas and stored Excel sources. Counts are a preview; the deletion also includes work saved before confirmation. A legacy source is bound to its storage-object ID so confirmation cannot target a replacement accidentally.

`cd_file_delete_call` atomically removes the dataset's current and migrated legacy database rows, including associated receipts. Current database and work-area writes share an advisory lock with deletion, so saves cannot leave orphaned work. A service-only `cd_file_deletions` tombstone retains target IDs/name, initial import request identities, source key and cleanup state; it contains no stop records or delivery history. The function then removes only server-resolved storage paths, updates the shared shortlist and marks cleanup complete. If storage or shortcut cleanup fails, the file stays unavailable and **Finish deletion** remains available to any signed-in profile, including after closing/reopening the app. Retrying a lost response is safe. Keep tombstones: they prevent cached requests and legacy listings from reviving deleted files. Deleted legacy names can be reused through a new private upload, not through the old legacy object path.

Deletion preserves profile accounts, unrelated files and the file-independent truck/trailer load log. Existing external downloads/exports cannot be removed, and offline open screens clear only after a successful availability check on reconnect. Do not manually delete storage metadata rows; the Edge Function uses the Storage API. Verify using `node tests/team-file-deletion.backend.cjs` and `node tests/team-file-deletion.browser.cjs` before release.

**Sync agreement deployed October 13, 2026:** `202610130003_sync_agreement.sql` updates the server comparison and adds a service-only delivery-value helper. Equal delivered totals agree automatically, independent note/count changes merge, and different competing totals or notes still require a decision. No Edge Function redeployment is needed. A read-only check found pending conflicts fell from 558 to 44; the one file, two copies, 5,364 source records, 917 versions, 1,946 drafts, one history event and 45 storage objects were unchanged. No profile was synced by this deployment. Publish the matching frontend for bulk choices and refresh open phones before reviewing again.

**Profile colors deployed October 13, 2026:** `202610130002_profile_colors.sql` adds profile colors to the protected directories, applies them to assigned work areas, and propagates admin color changes to existing areas with revision checks. The function is ACTIVE at version 7 and includes color validation in `admin-service.mjs`. Six requested delivery profiles were provisioned through the admin API; each password sign-in and color was verified, along with availability in the shared work-area profile picker. Credentials are not stored in this repository. No workbooks or delivery records were changed.

**Admin setup completed October 13, 2026:** `202610130001_profile_admin.sql` is installed and `profile-workbooks` is ACTIVE at version 6, bundling `index.ts`, `data-service.mjs` and `admin-service.mjs`. The requested Admin account was created and granted the server-controlled `cartdelivery_admin` role. A live password sign-in and admin-directory read succeeded. The one shared file, two copies, 5,364 delivery records and 45 storage objects were preserved. Public team reads still pass. Account mutations were tested with local fake Auth/database fixtures; production provisioning created only the requested administrator.

The database replacement migration and updated function were deployed on October 9, 2026, after the initial memory optimization failed in production. The active function bundles only `index.ts` and `data-service.mjs`, with no Excel parser. Tests passed locally; the user's first production import still needs confirmation. Pre-deployment read-only checks found zero registered originals/copies/syncs, zero managed workbook objects, and all 37 legacy storage objects present. Tests have not changed production workbooks. Both migrations are now installed; do not reapply them.

**Publish `index.html`, `app.js`, `style.css`, `profile-field-mapping.js`, `profile-import-worker.js`, and `record-fields-worker.js` together**, alongside existing assets. The old frontend API is incompatible with the new backend. Refresh open phones after publication. No frontend build is needed. The **View all fields** popup uses the existing source-download API; it requires no additional migration or Edge Function deployment.

## Deploy

**Backend deployed October 13, 2026:** the field-mapping, last-sync and shared-work-area migrations (`202610120002_import_field_mapping.sql`, `202610120003_last_sync_time.sql`, and `202610120004_profile_work_areas.sql`) were applied together in one transaction. The updated `profile-workbooks` function is ACTIVE at version 5. All six migration files are now installed; do not reapply them. This project was migrated through SQL queries and has no CLI migration-history table, so do not run an unreviewed `db push` against it.

Live checks confirmed work-area reads return the shared snapshot and profile directory, browser roles cannot access the table/RPC directly, unauthenticated work-area requests are rejected, and public team views still load. The existing one ready original, two copies, 5,364 records, 39 Excel-bucket objects and six GeoJSON-bucket objects were preserved. No work-area save was tested against production; mutations were verified using the local fake backend. The authenticated database read probe was rolled back.

The field-mapping migration adds nullable metadata and a service-role-only import wrapper. The last-sync migration reports the current copy owner's confirmed sync time. Work areas use `cd_work_areas` and a service-role-only RPC with revision checks and retry receipts; they do not change delivery records, copy revisions or Excel sources. Publish `profile-field-mapping.js` and `profile-import-worker.js` together with `index.html`, `app.js` and `style.css` when releasing the frontend.

**Backend deployed October 12, 2026:** [202610120001_public_team_views.sql](migrations/202610120001_public_team_views.sql) and the updated `profile-workbooks` function are installed. The first three migrations are installed; do not reapply them. Read-only production checks confirmed guest listing, shared record reads and the existing Cart Delivery shortlist work, while private listing still rejects missing/invalid authentication. The existing one ready original and two profile copies were preserved. No source files were uploaded or deleted.

The earlier sign-in error on the guest file picker came from the old deployed function rejecting `public-list` before the file list could load. Team files use the same uploaded originals and `_cart-delivery-tab.json` shortlist; there is no separate collection to populate. An outdated guest API now displays a server-update message, and guests never seed a missing shared shortlist.

The public GitHub Pages app already includes the work-area controls. Frontend updates publish from this repository; release `index.html`, `app.js` and `style.css` together so cache versions stay aligned. For future function deployments:

```powershell
supabase functions deploy profile-workbooks --project-ref lffazhbwvorwxineklsy --no-verify-jwt --use-api
```

The public-team-views migration adds a read-only function; it does not change records, copies, storage objects or table permissions. Do not revert to the old workbook-based function after database saves: old tables no longer represent current work.

For a fresh project, apply all ten migrations in filename order. Enable Email/password signup, disable email confirmation for username aliases, and require six-character passwords with no additional composition rules. Review project-wide Auth changes if other apps share the project. Aliases use `<username>@profiles.cartdelivery.invalid` and must not receive mail.

Bootstrap the first administrator through trusted Supabase administration: create the requested alias account, then set `app_metadata.cartdelivery_admin` to boolean `true` for its verified user ID. Merely choosing the username `admin` does not grant privileges. Never put its password or a service key in frontend code, migrations, documentation or test fixtures. Later password resets use the admin UI. The separate browser admin session is memory-only and does not replace the driver's login; use **Sign out of admin** to end it.

Profile renames update shared area labels and revisions. Disable blocks authenticated Edge actions, including existing sessions. Removal uses Auth soft deletion so delivery attribution and saved copies remain; assigned areas must be reassigned first. Audit events record the actor, target, action and whether a password changed, never the password itself. All admin tables/RPCs deny direct browser access.

`verify_jwt = false` is intentional: only `public-list`, `public-original`, `public-rows` and `public-export-source` bypass authentication. These expose ready shared originals, never profile drafts or copy metadata. Public rows require an original-mode request and matching shared revision. Every other action requires `auth.getUser(token)`. The service key stays in Supabase's function environment, never in source or frontend code. Browser roles cannot access managed tables or the RPCs directly. [Deployment reference](https://supabase.com/docs/guides/functions/deploy).

## Workflow and storage

The profile UI calls the shared original **team Excel**. **Start my own copy** creates a copy; **Continue my work** reopens it. **Sync to team Excel** shows an aggregate summary of changes relative to the current shared values: stops updated, carts added/removed, completed/reopened stops, notes and affected routes/days. Individual stop details are optional and load 50 at a time. Conflicts still require decisions; unresolved conflicts are excluded from totals until resolved. The final confirmation uses the same request and choices as its summary. **Check for team updates** offers a copy refresh when there are no pending edits. These frontend changes do not require a backend deployment or migration. “Team Excel” refers to the app's shared dataset; the imported source remains immutable, and downloading the team view creates an updated spreadsheet.

- First open imports records in batches. Later opens read database pages without downloading Excel.
- Signed-out team viewing never imports or creates a copy: it reads confirmed shared records, or the existing public Excel source when not yet imported. Team delivery records remain read-only; signed-in profiles can edit shared work-area boundaries in the team view. Signed-in users edit their own copies and sync through the final acknowledgement screen. The persistent team/copy banner is repeated inside dialogs.
- **Create my copy & open** creates an isolated profile view sharing immutable records. Only that profile's delivery changes are stored separately; no physical Excel duplicate is needed.
- Delivery saves validate and commit the whole request before markers change. Stale copy revisions are rejected.
- **Review & sync** compares baseline/profile/original by delivery meaning and notes separately. Matching counts agree without adding them; independent note and delivery edits merge. Different competing totals or notes require a choice. Apply team values, your changes, or the higher reported count to a whole batch, then adjust exceptions. Higher-count choices skip differing notes and unknown quantities; corrections that reduce delivered totals are highlighted before confirmation. Requires the installed `202610130003_sync_agreement.sql`; do not reapply it.
- Sync atomically updates shared values, audit history, and the profile baseline. Other profiles keep their baselines until they sync/refresh. Request receipts prevent duplicate operations.
- **View original** keeps delivery records read-only and allows signed-in profiles to manage shared work areas. **Download** exports the confirmed snapshot currently open; reopen first for newer work from another phone.

`cd_data_files` holds metadata, source location and original revision. `cd_data_records` stores imported records once. `cd_data_copies` holds copy/baseline revisions. `cd_data_drafts` stores changed records. `cd_data_versions` retains shared delivery values by record/revision, keeping other profiles' baselines stable.

`cd_data_history` / `cd_data_history_changes` store attribution, decisions and before/after fields. History lists 25 syncs per page; expanding one reads 250 changes/decisions at a time. `cd_data_receipts` makes mutations idempotent. All tables use RLS with browser access revoked; writes use the authenticated function and PostgreSQL transaction.

Record identity is its position among nonempty imported rows, including duplicates. Only `del_qty`, `del_status`, and `delivery_notes` can change. Other fields remain immutable. There is no record insertion/deletion/reordering; import a changed dataset under a new name.

Saves and sync never read or write workbook objects. Revision checks protect concurrent phones and prevent mixed-version paginated reads. Failed transactions roll back every edit. After an uncertain response, leave markers unchanged and reopen to establish server state.

Legacy `excel-files` objects remain frozen sources under existing restrictive policies. New sources upload once into private `profile-workbooks`, using signed tickets for new server-chosen paths with `upsert: false`. Use the confirmed team-file deletion flow above to remove a whole dataset and its associated data; do not remove individual sources, tables or history manually. Truck-load logs remain independent of team files. The previous `service.mjs` remains only for migration tests.

## Import and export

**Upload new team Excel** in Saved Files lets the user choose a source and confirm **Upload & add to Cart Delivery**. The frontend imports it, reloads the shared shortlist, and adds the new name only after import succeeds. A failed shortlist write preserves the completed import and offers a retry without a second upload. The current map remains open until the user chooses a file or opens their copy. No backend changes are needed for this flow.

`profile-import-worker.js` parses the first sheet in a browser worker, rejects macros/duplicate headings, and supplies batches of up to 250 records. The server validates row shapes. Partial imports stay hidden until finalization; retries resume confirmed batches. Existing datasets cannot be replaced. The importing profile supplies the initial record interpretation; the server does not independently re-parse Excel.

Limits: 50 MB per source and 100,000 nonempty records. Free Supabase projects allow uploads up to 50 MB, subject to lower project/bucket settings. [Storage limits](https://supabase.com/docs/guides/storage/uploads/file-limits). Import large files once from a computer if the phone cannot parse them. Ordinary phone opens/saves avoid Excel parsing, but map performance still depends on stop count.

Download fetches the immutable source and patches the open view's confirmed delivery fields into original worksheet rows. Blank rows, other cells/sheets and formulas are preserved. XLS/CSV inputs become XLSX downloads. No download uploads or syncs data. SheetJS cannot guarantee every advanced Excel feature; source bytes remain available.

Raw storage URLs return initial sources, not current delivery state. Use the app for current originals/profile views. `_currentWorkbook` is a lightweight view handle for database-backed files; use `profileExportWorkbook()` for actual Excel cells.

## Local verification

```powershell
npm install --prefix local-artifacts/test-tools playwright @electric-sql/pglite xlsx --no-audit --no-fund
node --check app.js
node --check profile-import-worker.js
git diff --check
node tests/profile-data.backend.cjs
node tests/profile-public.backend.cjs
node tests/profile-sync-summary.cjs
node tests/profile-sync-agreement.cjs
node tests/profile-data.migration.cjs
node tests/profile-workbooks.browser.cjs
node tests/work-areas.backend.cjs
node tests/work-areas.browser.cjs
node tests/profile-admin.backend.cjs
node tests/profile-admin.browser.cjs
node tests/profile-colors.backend.cjs
node tests/cart-counts.browser.cjs
node tests/resequence.browser.cjs
```

Tests use generated data, local PostgreSQL, fake Auth and intercepted Storage. They cover 5,364-row/36-column imports, whole-route saves/syncs, import retries, stale revisions, ownership, conflicts, migration, pagination, signed uploads, Excel exports and phone/desktop layouts. Never test saves against production storage. The old workbook backend suites support migration fixtures; the active suite is `profile-data.backend.cjs`.

Usernames are lowercase, 3–30 letters/numbers/underscores/hyphens, starting with a letter or number. Supabase stores password hashes; passwords never enter source or application localStorage. Delivery sessions persist in the browser; admin sessions do not. Use the app's admin UI to rename profiles or reset forgotten passwords so role protection and audit information are retained.
