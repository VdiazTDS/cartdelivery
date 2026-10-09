# Delivery profiles: deployment and operation

The app uses Supabase Auth, PostgreSQL and Storage. Excel is an immutable import/export source. Saves and sync commit database records; the Edge Function never loads SheetJS or workbook bytes.

## Current deployment

Project: `lffazhbwvorwxineklsy` (`VdiazTDS's Project`). The first migration `202610100001_profile_workbooks.sql` is installed; **do not run it again**. Email/password signup is enabled, email confirmation is disabled for username aliases, and passwords require eight characters.

The database replacement migration and updated function were deployed on October 9, 2026, after the initial memory optimization failed in production. The active function bundles only `index.ts` and `data-service.mjs`, with no Excel parser. Tests passed locally; the user's first production import still needs confirmation. Pre-deployment read-only checks found zero registered originals/copies/syncs, zero managed workbook objects, and all 37 legacy storage objects present. Tests have not changed production workbooks. Both migrations are now installed; do not reapply them.

**Publish `index.html`, `app.js`, and the new `profile-import-worker.js` together**, alongside existing assets. The old frontend API is incompatible with the new backend. Refresh open phones after publication. No frontend build is needed.

## Deploy

For the existing project, apply only [202610100002_database_deliveries.sql](migrations/202610100002_database_deliveries.sql) once in the SQL Editor while other clients are not saving. Then deploy:

```powershell
supabase functions deploy profile-workbooks --project-ref lffazhbwvorwxineklsy --no-verify-jwt --use-api
```

This migration preserves existing originals, profile baselines, pending changes, revisions and history. It retains old tables and every storage object. Do not revert to the old function after database saves: old tables no longer represent current work.

For a fresh project, apply both migrations in order. Enable Email/password signup, disable email confirmation for username aliases, and require eight-character passwords. Review project-wide Auth changes if other apps share the project. Aliases use `<username>@profiles.cartdelivery.invalid` and must not receive mail.

`verify_jwt = false` is intentional: every non-OPTIONS request is explicitly verified with `auth.getUser(token)`. The service key stays in Supabase's function environment, never in source or frontend code. Browser roles cannot access managed tables or the transaction function. [Deployment reference](https://supabase.com/docs/guides/functions/deploy).

## Workflow and storage

- First open imports records in batches. Later opens read database pages without downloading Excel.
- **Create my copy & open** creates an isolated profile view sharing immutable records. Only that profile's delivery changes are stored separately; no physical Excel duplicate is needed.
- Delivery saves validate and commit the whole request before markers change. Stale copy revisions are rejected.
- **Review & sync** compares baseline/profile/original. Conflicts require keeping original values, using profile changes, or entering a final total. Equal reported quantities can still conflict.
- Sync atomically updates shared values, audit history, and the profile baseline. Other profiles keep their baselines until they sync/refresh. Request receipts prevent duplicate operations.
- **View original** is read-only. **Download** exports the confirmed snapshot currently open; reopen first for newer work from another phone.

`cd_data_files` holds metadata, source location and original revision. `cd_data_records` stores imported records once. `cd_data_copies` holds copy/baseline revisions. `cd_data_drafts` stores changed records. `cd_data_versions` retains shared delivery values by record/revision, keeping other profiles' baselines stable.

`cd_data_history` / `cd_data_history_changes` store attribution, decisions and before/after fields. History lists 25 syncs per page; expanding one reads 250 changes/decisions at a time. `cd_data_receipts` makes mutations idempotent. All tables use RLS with browser access revoked; writes use the authenticated function and PostgreSQL transaction.

Record identity is its position among nonempty imported rows, including duplicates. Only `del_qty`, `del_status`, and `delivery_notes` can change. Other fields remain immutable. There is no record insertion/deletion/reordering; import a changed dataset under a new name.

Saves and sync never read or write workbook objects. Revision checks protect concurrent phones and prevent mixed-version paginated reads. Failed transactions roll back every edit. After an uncertain response, leave markers unchanged and reopen to establish server state.

Legacy `excel-files` objects remain frozen sources under existing restrictive policies. New sources upload once into private `profile-workbooks`, using signed tickets for new server-chosen paths with `upsert: false`. Truck-load logs and Cart Delivery tab metadata keep their existing behavior. Do not delete sources, old tables, versions, receipts or history without a retention plan checking references. The previous `service.mjs` remains only for migration tests.

## Import and export

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
node tests/profile-data.migration.cjs
node tests/profile-workbooks.browser.cjs
node tests/cart-counts.browser.cjs
node tests/resequence.browser.cjs
```

Tests use generated data, local PostgreSQL, fake Auth and intercepted Storage. They cover 5,364-row/36-column imports, whole-route saves/syncs, import retries, stale revisions, ownership, conflicts, migration, pagination, signed uploads, Excel exports and phone/desktop layouts. Never test saves against production storage. The old workbook backend suites support migration fixtures; the active suite is `profile-data.backend.cjs`.

Usernames are lowercase, 3–30 letters/numbers/underscores/hyphens, starting with a letter or number. Supabase stores password hashes; passwords never enter source or application localStorage. Sessions persist in the browser. Administrators reset forgotten passwords through Supabase Auth; do not change alias emails.
