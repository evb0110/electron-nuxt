# Sentry account controls

This file records the configuration EVB Viewer requires before diagnostics can
send production events. It contains setting names and policy decisions only.
Never add DSNs, tokens, project identifiers, private endpoints, screenshots, or
event contents.

The server-side scrubber is a backstop. Runtime adapters must still construct
every remote event from the closed diagnostic record and must never send a raw
error, message, path, URL, request, document value, or arbitrary object.

## Organization access

| Control | Required value | Verification |
| --- | --- | --- |
| Data storage region | European Union | Owner verified 2026-09-03 |
| Generative AI features | Disabled | Pending |
| Seer | Unconfigured | Owner verified 2026-09-03 |
| Shared issues | Disabled | Pending |
| Join requests | Disabled | Pending |
| Open team membership | Disabled | Pending |
| Member invitations | Disabled | Pending |
| Member project creation | Disabled | Pending |
| Member event deletion | Disabled | Pending |
| Member monitor and alert editing | Disabled | Pending |
| Attachment access | Owner | Pending |
| Debug-file access | Owner | Pending |
| Pay-as-you-go spending limit | Zero | Owner verified 2026-09-03 |
| Payment method | None required | Owner verified 2026-09-03 |

## Authentication and recovery

Google organization OAuth and Sentry-native two-factor authentication are
separate controls. The owner must verify the recovery path and the membership
scope before organization-wide enforcement changes. The preferred result is
Google OAuth backed by strong Google account recovery, without retaining a
second routine Sentry login path. If Sentry cannot safely restrict a personal
Google account, use a Sentry passkey and recovery codes instead.

| Control | Required value | Verification |
| --- | --- | --- |
| Sole owner access | Retained throughout migration | Owner verified 2026-09-03 |
| Google OAuth membership scope | Restricted to the owner account | Pending provider validation |
| Independent recovery methods | Two verified methods | Pending owner verification |
| Organization 2FA requirement | Enable only if required after OAuth decision | Pending provider validation |

## Privacy and scrubbing

| Control | Required value | Verification |
| --- | --- | --- |
| Enhanced Privacy | Enabled | Pending |
| Required Data Scrubber | Enabled | Pending |
| Required default scrubbers | Enabled | Pending |
| IP address storage | Prevented | Pending |
| JavaScript source fetching | Disabled before production events | Pending |
| Minidump attachment storage | Disabled | Owner verified 2026-09-03 |
| Aggregated identifying service data use | Disabled | Owner verified 2026-09-03 |
| Global safe fields | Empty | Pending |

The global sensitive-field list must cover the forbidden transport categories
without matching canonical frame fields or Debug ID metadata. Record the final
list here after the closed diagnostic contract lands and the Sentry setting is
verified.

## Projects and credentials

Create credentials only after the named runtime consumer exists. Record secret
names and their runtime purpose here, never their values.

| Item | Required state | Verification |
| --- | --- | --- |
| `evb-viewer-desktop` project | One restricted desktop client key | Pending |
| `evb-viewer-web` project | Separate restricted browser and Nitro client keys | Pending |
| Browser allowed origins | Exact production and preview viewer origins | Pending |
| Source-map upload token | Created just in time with least privilege | Pending |
| Desktop runtime secret | Name and distribution target recorded | Pending |
| Browser runtime secret | Name and Vercel target recorded | Pending |
| Nitro runtime secret | Name and Vercel target recorded | Pending |

## Retention and operations

| Control | Required value | Verification |
| --- | --- | --- |
| Platform event retention | 90 days | Pending live verification |
| Resolved-issue deletion | Weekly operator procedure | Pending |
| Quota alerts | Enabled with pay-as-you-go still disabled | Pending |
| Source-map access review | Owner-only and verified after upload | Pending |
| Removal procedure | Tested without sending a production event | Pending |

The alert definitions, weekly deletion procedure, privacy incident response,
credential rotation, emergency disablement, canary evidence tables, and package
removal rehearsal are in `sentry-runbook.md`.
