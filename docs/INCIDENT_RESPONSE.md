# Phone Farm incident response

Status: deployable local configuration, not a completed production exercise.
Prometheus evaluates the rules below when the Compose `monitoring` profile is
enabled. An owner must still connect an approved alert receiver, external
health check, and on-call destination, then exercise delivery.

Never paste session cookies, tokens, proxy credentials, typed phone text,
screenshots, private media, or full request bodies into tickets or chat.

## First response

1. Record start time, affected environment, and the alert name.
2. Check `/healthz` from outside the host and `/readyz` from the trusted
   operations network. Do not expose `/metrics` publicly.
3. Preserve bounded application/desktop logs and deployment revision. Redact
   secrets before sharing.
4. Stop risky mutations if authorization, persistence, or routing state is
   uncertain. Do not label a phone protected without a fresh device-originated
   egress check.
5. Prefer rollback to the last verified release. Never delete or rewrite the
   primary data store during triage.

## PhoneFarmMetricsUnavailable

- Confirm the hub container is running and `/healthz` answers.
- Confirm `METRICS_BEARER_TOKEN` is present in both the hub environment and the
  Prometheus secret, without printing it.
- Check whether `/readyz` reports an unavailable authoritative dependency.
- If the application is unavailable, roll back or restart under the process
  supervisor; record recovery time.

## PhoneFarmHighServerErrorRatio

- Correlate the start time with a release or dependency outage.
- Inspect bounded error kinds, readiness, PostgreSQL, and Redis health. Do not
  copy raw exception payloads containing private data.
- If a new release caused the increase, roll it back. Verify authorization and
  one harmless read before reopening mutations.

## PhoneFarmProcessRestarted

- Determine whether the restart was planned.
- Inspect supervisor restart counts and the final sanitized log lines.
- Repeated restarts require traffic removal and rollback; do not rely on an
  infinite restart loop.

## PhoneFarmRoutingUnverified

- Treat the affected routing state as unprotected; the aggregate does not identify a device.
- In the authenticated fleet UI, locate routed devices without a fresh device-originated verification result.
- Stop the affected route if protection cannot be reverified. Do not substitute host-side proxy health for phone egress evidence.

## PhoneFarmOpenChallenge

- Open the authenticated intervention queue and assign the challenge to an authorized human operator.
- Do not place challenge text, screenshots, account names, or device identifiers in alert labels or tickets.
- Verify the AI task remains stopped until the intervention is resolved through the normal approval/handoff path.

## Closeout evidence

Record detection time, acknowledgement time, mitigation, recovery time,
revision, affected tenants/devices, data-loss assessment, authorization check,
and follow-up owner. A production acceptance requires a delivered test alert
and a timed incident exercise; configuration files alone are insufficient.
