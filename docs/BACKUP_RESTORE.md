# Encrypted file backup and disposable restore

Status: encrypted file backup/restore and encrypted PostgreSQL dump packaging
are locally implemented and automatically tested. The PostgreSQL helper runs
`pg_dump`/`pg_restore` without placing a password in process arguments and
requires an explicit disposable-restore confirmation. A real PostgreSQL dump
and restore have not run on this Windows host. This does **not** provide
point-in-time recovery, select a production retention schedule, or prove a
production RPO/RTO.

## Coordinated encrypted backup sets

Use the backup-set command when durable file state and PostgreSQL must share one publication boundary:

```powershell
cd system
npm.cmd run backup:set -- --source .\storage --output D:\phone-farm-backups\set-2026-10-02 --key-file D:\secrets\backup.key --required-secret SESSION_SECRET
npm.cmd run verify:backup-set -- --backup D:\phone-farm-backups\set-2026-10-02
```

The command builds both encrypted components in private staging, records a random set ID, component hashes,
schema versions, timestamps, and required secret names in `backup-set.json`, verifies membership, and publishes
the directory with one rename. A failed component removes staging output and never publishes the destination.

Restore requires a new filesystem target, the exact disposable database name, and the literal confirmation:

```powershell
$env:PGDATABASE = "phone_farm_restore_20261002"
npm.cmd run restore:set -- --backup D:\phone-farm-backups\set-2026-10-02 --target D:\phone-farm-restores\run-20261002 --database phone_farm_restore_20261002 --key-file D:\secrets\backup.key --confirm "RESTORE INTO DISPOSABLE DATABASE"
```

The manifest is an integrity and membership record, not a secret store. This local workflow does **not** prove
cross-component crash consistency, PostgreSQL PITR, off-host durability, an approved retention period, RPO/RTO,
or a measured restore drill.

The backup format streams every regular file through AES-256-GCM into an opaque
object name. The encrypted manifest contains the original relative paths,
checksums, sizes, and the names (never values) of secrets that a restore must
rebind. Symbolic links, an output inside the source, existing destinations,
tampered ciphertext, unsafe paths, weak keys, and missing required secrets fail
closed. Restore writes to a temporary sibling and publishes the target only
after every file decrypts and matches its recorded size and SHA-256 checksum.
The local format is bounded to 100,000 files, 128 required-secret names,
1,024-character relative paths, and a 64 MiB encrypted manifest. Restore reads
and validates the manifest through one file descriptor; oversized manifests,
manifest symbolic links, and a path swap fail before a target is created.

## Create a key without printing it

Keep the key outside the repository and outside the backup destination. Protect
it with the host's credential/secret system. This PowerShell example creates a
new 32-byte key file without writing its value to the console:

```powershell
$key = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($key)
[IO.File]::WriteAllBytes('C:\secure\phone-farm-backup.key', $key)
Remove-Variable key
```

## Back up the file store

Stop or quiesce the hub before copying its live file store; this first slice
does not coordinate a crash-consistent snapshot with concurrent writers.

```powershell
cd 'C:\path\to\PHONE FARM\system'
npm.cmd run backup:files -- --source '.\storage' --output 'D:\phone-farm-backups\files-2026-09-30' --key-file 'C:\secure\phone-farm-backup.key' --required-secret SESSION_SECRET
```

Add every external secret required to interpret restored encrypted records as a
separate `--required-secret NAME`. Only the environment-variable names enter
the encrypted manifest. Their values remain in the deployment secret manager.

## Disposable restore drill

Never restore over a live file store. The target must not already exist. Rebind
each required secret in the environment, restore to a disposable directory,
then start a disposable hub against that directory and verify authorization,
files, evidence, audit reads, and session policy before measuring the drill as
accepted.

```powershell
$env:SESSION_SECRET = '<read from the deployment secret manager>'
cd 'C:\path\to\PHONE FARM\system'
npm.cmd run restore:files -- --backup 'D:\phone-farm-backups\files-2026-09-30' --target 'D:\phone-farm-restore-drill\storage' --key-file 'C:\secure\phone-farm-backup.key'
Remove-Item Env:\SESSION_SECRET
```

Both commands print only operation, file/byte counts, elapsed milliseconds, and
the output path. They never print key or secret values.

## PostgreSQL encrypted dump and disposable restore

Keep connection values in `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and
`PGDATABASE`; the CLI never accepts a password argument. `pg_dump` and
`pg_restore` must be installed or named by `PG_DUMP_BIN`/`PG_RESTORE_BIN`.

```powershell
$env:PGDATABASE = 'phone_farm'
$env:PGPASSWORD = '<read from the deployment secret manager>'
npm.cmd run backup:postgres -- --output 'D:\phone-farm-backups\postgres-2026-10-02' --key-file 'C:\secure\phone-farm-backup.key' --required-secret SESSION_SECRET
```

Restore is intentionally gated and must target a separately created,
disposable database. It never creates or selects a production database:

```powershell
$env:PGDATABASE = 'phone_farm_restore_drill'
npm.cmd run restore:postgres -- --backup 'D:\phone-farm-backups\postgres-2026-10-02' --key-file 'C:\secure\phone-farm-backup.key' --confirm 'RESTORE INTO DISPOSABLE DATABASE'
```

Remove database secret environment variables when the operation finishes.

## Still required before a disaster-recovery claim

- Owner-approved RPO, RTO, backup retention, and deletion rules.
- A real `pg_dump`/`pg_restore` drill and a PostgreSQL PITR or provider-snapshot strategy.
- A coordinated database/file snapshot or reconciliation procedure.
- Off-host encrypted storage, access controls, rotation, monitoring, and alerts.
- A timed disposable restore using production-shaped data, followed by an
  application-level authorization and object/evidence reconciliation check.
- Recorded rollback and incident evidence. Local automated round trips are not
  a production restore drill.
