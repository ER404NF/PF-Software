# ADR-0004: Store large bytes in S3-compatible object storage

**Status:** Accepted
**Date:** 2026-09-25
**Deciders:** Engineering, security and operations; provider/region requires owner approval

## Context

Device uploads and research evidence are currently local files. PostgreSQL is not appropriate for potentially
large screenshots, recordings, diagnostics, exports and uploads.

## Decision

Use S3-compatible object storage for large bytes. PostgreSQL owns object metadata, classification, checksum,
tenant/resource ownership and lifecycle state. Clients receive only short-lived, operation-specific signed access
after exact API authorization.

## Options considered

| Option | Scale | Authorization model | Backup/lifecycle | Assessment |
| --- | --- | --- | --- | --- |
| S3-compatible objects + DB metadata | High | API + short-lived signatures | Mature | Selected |
| Shared filesystem | Limited/mount-dependent | Application paths | Operationally fragile | Site-local cache only |
| PostgreSQL bytea | Poor for large/high-volume bytes | Transactional | Inflates DB/PITR | Rejected for large objects |
| Public/static object URLs | High | Key knowledge | Unsafe | Rejected |

## Trade-offs

Metadata and bytes can diverge across failures. Uploads/deletions therefore require staged state, checksums,
idempotent jobs and reconciliation rather than pretending one distributed transaction exists.

## Consequences

- Opaque keys include organization namespace but reveal no email/handle/filename.
- Original filename is display metadata only.
- Evidence access remains tenant/account scoped.
- Versioning/lifecycle and deletion verification are operational requirements.

## Action items

1. [ ] Define file-object states and upload/finalize/delete workflows.
2. [ ] Add local S3-compatible test service and authorization tests.
3. [ ] Build checksum/parity migration for current media/evidence.
4. [ ] Select provider, region, retention and malware policy.

