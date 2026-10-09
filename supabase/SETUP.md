# Delivery profiles: deployment and operation

The frontend now requires this backend for workbook editing. It deliberately has no fallback that overwrites the shared Excel file. Until setup is complete, the profile screen reports that setup is required. Local automated tests do not install anything in the live project.

## Current deployment

The backend is installed in project `lffazhbwvorwxineklsy` (`VdiazTDS's Project`). The migration has been applied; **do not run it again**. The `profile-workbooks` Edge Function is active. Email/password signup is enabled, email confirmation is disabled for username aliases, and the minimum password length is eight characters. These settings are declared in `config.toml`; other project settings were left unchanged.

Deployment checks confirmed all five tables have RLS enabled with browser access revoked, the commit function is server-only, the workbook bucket is private, and the restrictive storage policies are installed. The deployed function rejects missing/invalid credentials and accepts browser preflight requests. All 37 existing objects in `excel-files` remained present; deployment verification did not upload, edit, or delete customer workbooks or create test accounts. Full save/sync scenarios were tested using the local fixtures, not production data.

**Frontend publication remains a separate step.** Publish the updated static files together and have teams refresh before resuming deliveries. The migration already blocks direct route saves from old app versions. Once the updated frontend is published, each team can create its own username/password and open its own copy. The steps below document setup for a fresh project and future function deployments.

## Deploy

1. Schedule a cutover when teams have finished saving in the old app. Export their latest workbooks first. The migration freezes direct writes to existing route files, so already-open old app versions will no longer be able to save them.
2. In the existing Supabase project's SQL Editor, run [202610100001_profile_workbooks.sql](migrations/202610100001_profile_workbooks.sql) once. It creates five `cd_*` tables, one transaction function, a private `profile-workbooks` bucket, and restrictive storage policies. It does not delete or rewrite existing workbooks or truck-load data. Do not apply it to an unrelated project.
3. In **Authentication → Sign In / Providers**, enable Email/password sign-in, allow new user signups, and disable **Confirm email** for this username-only workflow. Set the minimum password length to 8. The app maps lowercase usernames to `<username>@profiles.cartdelivery.invalid` internally; people never enter an email address and these aliases must not receive mail. Supabase stores and verifies password hashes. Duplicate usernames are rejected by Auth and the profile table. If this Supabase project also serves apps that require email verification, use a separate Auth project/design before changing this project-wide setting. See [Supabase's Auth configuration](https://supabase.com/docs/guides/auth/general-configuration).
4. Install/login to the Supabase CLI on your own machine and deploy the function from this repo:

   ```powershell
   supabase login
   supabase functions deploy profile-workbooks --project-ref lffazhbwvorwxineklsy --no-verify-jwt
   ```

   Add `--use-api` to deploy without Docker. To apply only the Auth settings explicitly declared in `config.toml`, review `supabase config diff --project-ref lffazhbwvorwxineklsy`, then run `supabase config push --project-ref lffazhbwvorwxineklsy` with the current CLI. Review the diff before accepting changes.

   The included `config.toml` also sets `verify_jwt = false`. Every non-OPTIONS request is explicitly verified with `auth.getUser(token)` inside the function; this supports Supabase's current signing keys. The function uses Supabase-provided `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment variables. Never copy the service key into `app.js`, the repository, or the chat. [Deployment reference](https://supabase.com/docs/guides/functions/deploy).
5. Publish the static `index.html`, `app.js`, and `style.css` together. Have each team refresh the app, create its username/password, and choose **Open Saved Files → All Files → Create my copy & open**. Existing Excel files are imported into the versioned system on first use. Subsequent opens resume that profile's saved copy. Names already used by originals cannot be overwritten by uploading another file.

For production verification, create two profiles and use a disposable workbook in a separate staging project. Exercise independent saves, conflicting changes, sync, and history before the first route. All included automated tests use generated data and a local database; none writes to the production bucket.

## Daily workflow

- Tap the username at the top of the map to open the profile panel.
- **Choose file** opens the shared originals list. **Open my copy** resumes that profile's copy on any signed-in phone. Different profiles never save to the same copy. Two phones using the same profile are protected by version checks, but a stale phone must reopen before editing further.
- Mark deliveries with the existing selection and cart-count controls. The header shows how many records in your copy differ from your last synced baseline. Every save must be confirmed by the server before markers change.
- **Review & sync** compares the baseline, your copy, and the current original. Different records merge automatically. If both your copy and the original changed the same record, choose **Keep original**, **Use my changed values**, or enter the final delivered-cart total for all teams combined. Even equal reported quantities flag an overlap. Nothing syncs until you press **Confirm sync to original**.
- A successful sync refreshes your copy to the latest original and advances its baseline. Repeating sync does not add the same carts again. With no changes, the same flow offers **Refresh my copy from original**.
- **Original's history** lists profile names, timestamps, original versions, exact before/after fields, and conflict decisions. Entries are expandable and paginated. **View original** opens the latest shared workbook read-only; the existing download button exports it. Viewing a profile copy exports that profile's copy instead.
- An expired/failed sign-in or uncertain connection never falls back to writing an original. If a request cannot be confirmed, reopen the copy to check its server state before retrying work. Sync retries reuse their request ID. No offline editing queue is included.

## Storage and concurrency

`cd_files` is the registry of originals. `cd_copies` records the owner, original baseline, current rows, workbook revision, and path for each profile/file pair. `cd_syncs` is the original's audit trail. `cd_receipts` records confirmed operations for idempotent retries. `cd_profiles` binds a unique username to a verified Auth user ID. Only the Edge Function's server role can access these tables; browser roles cannot call the commit function or write the private workbook bucket.

Each saved version is a real Excel object at a new immutable path. The server uploads it first, then `cd_commit` locks the original and profile-copy rows, checks their expected versions, and atomically switches the pointers, updates baselines, writes the audit entry, and records the receipt. If another request committed first, this transaction rejects the stale request. No shared object is overwritten. An interrupted transaction can leave an unreferenced file but cannot make a partial workbook visible.

**“Original” in the app means the latest version referenced by `cd_files.workbook_path`.** An imported legacy object such as `excel-files/Trash.xlsx` remains a frozen initial snapshot; its old public URL does not become the live original. Open/download the current original through this app. Updating that old storage object separately would reintroduce an unsafe two-system write, so this implementation does not do that. The exact initial upload is retained as `cd_files.original_path`. XLS/CSV inputs get XLSX working versions; macros are not supported as input.

Other sheets and unchanged worksheet cells/formulas are preserved by editing only changed cells. Workbooks are still processed by SheetJS, so advanced Excel features outside its support are not guaranteed to round-trip; the byte-for-byte initial upload remains available to the administrator. Imports currently allow up to 20 MB and 100,000 nonempty rows in the first sheet and require unique column headings.

Row identity is the position within the imported dataset, including a separate record for every duplicate address/bin. There is no in-app row insertion, deletion, sorting of workbook rows, or replacement of an existing original. Import a changed dataset under a new name. Only `del_qty`, `del_status`, and `delivery_notes` are mergeable; the current UI edits the first two. Browser-only settings and Optimo route order are not spreadsheet changes and do not sync. Optimo snapshots are scoped to the signed-in profile and device. Truck/trailer load groups remain a separate shared log.

Previous original versions are referenced by the audit's `before_path`/`after_path`; earlier profile save versions can be located through receipts. Keep these objects for recovery. Do not delete apparently old objects or receipts without a retention plan that checks all references. For recovery, an administrator can download a retained object and import it under a new name, preserving the existing original and its history.

Usernames are lowercase, 3–30 letters/numbers/underscores/hyphens, starting with a letter or number. Passwords are not stored in source or application localStorage; Supabase persists a login session in the browser. There is no email-based password recovery for the internal aliases. An administrator must reset a forgotten password through Supabase Auth's server-side administration tools. Do not change the alias email: it is the username.

## Local verification

Install test-only dependencies (ignored by Git):

```powershell
npm install --prefix local-artifacts/test-tools playwright @electric-sql/pglite xlsx --no-audit --no-fund
node --check app.js
git diff --check
node tests/profile-workbooks.backend.cjs
node tests/profile-workbooks.browser.cjs
node tests/cart-counts.browser.cjs
node tests/resequence.browser.cjs
```

The backend suite executes the actual migration and transaction in PGlite (PostgreSQL), including restrictive policy checks, independent profile saves, simultaneous saves and syncs, stale revisions, duplicate requests, rejected uploads, conflicts, audit attribution, and preserved workbook formulas. The browser suite uses that backend with fake Auth and in-memory Storage, checks both 440×956 and desktop layouts in both themes, and never sends requests to live Supabase. Hosted Auth configuration and the deployed Edge Function still require staging verification.
