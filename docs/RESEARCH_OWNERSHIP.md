# Research ownership and access

Implemented 2026-09-09 for MS3.3. A workspace is the research ownership boundary
(normally one client); each research account belongs to exactly one workspace.
Account IDs are globally unique because the HTTP URL still identifies an account
without a workspace segment. Multiple accounts may share an owning workspace.

## Configuration

Register ownership in `system/research.config.json`:

```json
{
  "accounts": [
    {
      "id": "creator-a-instagram",
      "workspaceId": "client-a",
      "platform": "instagram",
      "actionPolicy": {
        "observe": "ALLOW_AUTONOMOUS",
        "scroll_next": "ALLOW_AUTONOMOUS",
        "copy_link": "REQUIRE_APPROVAL"
      }
    },
    { "id": "creator-b-reddit", "workspaceId": "client-b", "platform": "reddit" }
  ]
}
```

Account and workspace IDs must be lowercase, start with a letter or number,
contain only letters, numbers, underscores and dashes, and be at most 100 characters.
Windows device names such as `con` are rejected. Lowercase prevents filesystem
case aliases from creating ambiguous ownership on Windows. Each account also
requires one supported platform: `instagram`, `reddit`, or
`x`. Duplicate account IDs, unsupported platforms, or invalid ownership fail startup. The shipped account list is empty: it grants
no access and makes no assumption about actual clients.

Every omitted action defaults to `DISABLED`. Allowed values are
`ALLOW_AUTONOMOUS`, `REQUIRE_APPROVAL`, and `DISABLED`. During MS8, only
read-only observation/navigation/capture/link actions can pass the validator;
platform-visible actions such as likes, votes, saves, reposts and comments are
denied even if configuration attempts to enable them.

Assign `allowedResearchWorkspaces: ["client-a"]` on the relevant operator entry
in `system/operators.config.json`. This is independent of `role` and
`allowedDevices`. Missing, null, malformed or empty grants deny research access;
there is no wildcard and admins receive no implicit research access.

The existing operator creation/update helper accepts
`--research-workspaces=client-a,client-b`. An empty `--research-workspaces=`
revokes all grants; omitting the flag preserves existing research grants on an
update and grants none to a new operator. Other existing helper behavior remains:
omitting role/device arguments resets those fields to VA/all devices, so include
the intended role/device arguments when using it to update an existing operator.
Enter credentials locally; never put them in project documentation.

Restart the relay after editing either config. Research authorization resolves
the operator's current startup-loaded registry entry by session username, so
persisted sessions cannot retain old workspace grants after restart. A deleted
operator is denied even if its old session cookie still exists.

## HTTP and storage boundary

All account-specific research routes (evidence, list/get/create runs, and candidate review)
check authorization before accessing storage. Unauthenticated requests return 401;
unknown and unauthorized accounts both return 403. A caller-supplied workspace or
account in the JSON body cannot override the URL account's configured ownership.

Storage is now `system/storage/research/<workspaceId>/<accountId>.json`.
New runs include their owning `workspaceId`. Creation and candidate changes record
workspace/account context in the audit log; denials are audited too.
Captured evidence is stored separately under
`system/storage/research-evidence/<workspaceId>/<accountId>/` and is served only
through the protected account evidence route.

## Existing data and migration

Legacy `storage/research/<accountId>.json` files are never read as a fallback,
moved, or deleted automatically. To migrate an existing account:

1. Stop the relay and back up its research storage.
2. Establish the actual client owner and register the account/workspace above.
3. Inspect the legacy file. Confirm all runs belong to that account/client. Split
   mixed-client records before migration; never copy a mixed file wholesale.
4. Add the correct `workspaceId` to every run and keep its account field consistent
   with the registered account ID. Copy the reviewed file to the workspace path.
   Do not overwrite an existing destination; reconcile its runs separately first.
5. Assign explicit operator grants, restart, and verify allowed and denied access.
6. Retain the original backup according to the client's retention requirements.

No customer accounts, operator grants or existing research files were migrated as
part of this code change.

## Scope and verification

The automated HTTP tests exercise both clients, all four routes, restricted admin
denial, forged ownership fields, unknown accounts, revoked grants and removed
operators using existing sessions. Store tests cover separate workspace paths,
invalid paths and refusal to expose legacy files. Existing device/file RBAC tests
remain part of the full suite.

This boundary protects research records. The existing admin queue/audit interfaces
remain global oversight surfaces, and fleet status visibility remains global to
authenticated operators. This is not full multi-tenant isolation of every surface.
The production MS8 runner rechecks this account authorization before every
bounded step and before saving evidence. `/cresearch` resolves one exact
authorized, platform-matching account; callers may provide the account ID, while
the shorter form succeeds only when exactly one authorized account matches.
Verified discoveries write research candidates automatically.
