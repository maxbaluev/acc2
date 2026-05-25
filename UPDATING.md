# Updating AccInt v2

acc2 release distribution uses signed IPFS+Pinata bundles. The `acc update` command intentionally accepts only an IPFS CID source; it does not pull from git or silently fall back to git.

Local self-hosting development can still use a plain git checkout workflow. That workflow is for an operator's own local source tree, not the release-distribution channel inside `acc update`.

## Release Update Flow

```bash
# 1. Apply a signed release bundle by CID
cd /path/to/bos2/system/acc2
bun cli/dispatch.ts update --yes --source ipfs-cid --cid <release-bundle-cid>

# Optional: use a specific gateway
bun cli/dispatch.ts update --yes --source ipfs-cid --cid <release-bundle-cid> --gateway https://gateway.pinata.cloud

# 2. Confirm the new build is live
bun cli/dispatch.ts doctor
bun cli/dispatch.ts version
```

`acc update` verifies the signed release manifest, applies any compatible `upgrade_chain` intermediates before the target release, enforces `min_acc_version`, stages files by checksum, runs schema migrations, restarts the daemon, and rolls the local source tree back if post-update health fails.

## Local Checkout Workflow

For a self-hosting development checkout, updating local source remains manual:

```bash
# 1. Pull local development source
cd /path/to/bos2 && git pull

# 2. Refresh dependencies (no-op when package.json is unchanged)
cd system/acc2 && bun install

# 3. Restart the daemon so it loads the new commit
bun cli/dispatch.ts daemon restart        # atomic stop + drain + start + health-poll
#   OR under a service manager
#   systemctl --user restart accint
#   launchctl unload ~/Library/LaunchAgents/com.accint.daemon.plist && launchctl load <same path>

# 4. Confirm the new build is live
bun cli/dispatch.ts doctor
bun cli/dispatch.ts version
```

After step 4, `acc version` should report a `daemon loaded_git_head` that matches `git rev-parse HEAD`. If it still shows the old commit, the daemon did not restart cleanly; re-run `acc daemon restart` and check `acc daemon status`.

## What happens to the schema

The substrate schema is versioned in `substrate/schema.sql`. Migrations run at daemon boot via `runMigrations` and through `acc update` after release files are applied. They are idempotent: a boot with no pending migration is a no-op, and each applied migration is recorded as a `schema_migration_applied` event in the ledger. The daemon refuses to start if a migration fails, so the old process keeps running until a clean restart succeeds; your accumulated state (`~/.accint/state.db`) is never silently corrupted by a bad upgrade.

## What survives an update (and what doesn't)

The substrate is a single SQLite file at `~/.accint/state.db` (configurable via `ACC2_STATE_DIR` / `ACC2_DB_PATH`). It is not in the source tree and is not touched by git pull. Your accumulated judgment, knowledge, and ledger persist across every update. Back it up (`cp ~/.accint/state.db <backup>` while the daemon is stopped, or use the WAL-safe copy in `docs/ops-guide.md` §6) before a major upgrade if you want a rollback point.

## Hot-reload (optional)

When the daemon runs under `acc daemon supervise`, an outer supervisor detects local source changes and swaps the child generation automatically once the open brain dispatch queue can drain. See `acc daemon supervise --help` and `docs/ops-guide.md` §4 for the service-managed path. Manual operators use the `daemon restart` step above.

## Keeping external dependencies current

acc2's host dependencies (opencode, bun, uv, camoufox) update independently. Run `bun cli/dispatch.ts admin upgrade-check` for a one-line-per-subsystem report, and see `docs/ops-guide.md` §5a for the per-component refresh commands.
