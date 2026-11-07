# Swipr Arkiv schema

Swipr uses Rabdi (chain **7794095**) with SDK **1.0.1**. Indexed `project = 'swipr-mumbai26'` identifies the application; `arkiv.schema` identifies the schema. Native `$owner`, `$creator`, `$expiresAt` and creation flags are authoritative system fields.

## Wallet-owned entities

Definitions: [wallet-profile.ts](../backend/contracts/wallet-profile.ts). Structured payloads are UTF-8 JSON encoded in `bytes` attributes; indexed strings are short lookup values.

| Schema | Indexed application fields | Payload | Native owner | Initial expiration / flags |
| --- | --- | --- | --- | --- |
| `swipr.wallet-profile.v1` | `project`, `status` | `profile` bytes: name, operator, strategy, assets, image reference and seat capacities | Profile's user wallet | Browser creates: 30 days; prepared bot creates use native `minLifetime = 1296000`; mutable |
| `swipr.wallet-social.v1` | `project` | `following` bytes: followed wallets | User wallet | 30 days; mutable |
| `swipr.wallet-signal.v1` | `project`, `profileId` | `signal` bytes: bot proposal | Signing operator wallet | Prepared create sets native `minLifetime = 1296000`; read `$expiresAt` for the actual expiration block |
| `swipr.wallet-ghost.v1` | `project`, `status` | `ghost` bytes: trader, start, amount and simulation expiry | Copier wallet | 30 days; mutable; simulation window at most 7 days |
| `swipr.wallet-seat.v1` | `project` | `join` bytes: trader, terms, seat type and budget version | Copier wallet | 90 days; readonly join terms |
| `swipr.wallet-seat-invite.v1` | `project`, `profileId`, `invitee`, `status` | Invitation target in attributes | Trader wallet | 90 days; revocable by owner |
| `swipr.wallet-automation.v1` | `project` | `grant` bytes: pass-linked permission description | Copier wallet | 90 days; readonly; actual signing policy is in Privy |
| `swipr.wallet-settlement.v1` | `project`, `seatId` | `receipt` bytes | Signing wallet | 180 days; readonly; not proof of a live positive-profit settlement |

Client write paths: [profile/social](../frontend/src/lib/arkiv.ts), [ghost](../frontend/src/lib/wallet-ghosts.ts), [seats/invitations](../frontend/src/lib/wallet-seats.ts), [automation](../frontend/src/lib/automation.ts). Prepared bot writes are validated by the [gateway](../backend/bots/gateway.ts).

The application validates native ownership before accepting a profile, invitation, grant or mutation. A profile's editable payload is not an authority for ownership or historical performance.

Private seats restrict joining to invited wallets; invitation metadata on Arkiv is still public.

## Service-owned operational records

| Schema | Indexed fields | Payload / purpose | Native owner and lifetime |
| --- | --- | --- | --- |
| `swipr.engine-event.v1` | `project`, `stream`, `revision`, `eventId` | `body` bytes; durable reservations, submissions, pass accounting and reconciliation | Service writer; 180 days; readonly and permissionless extension |
| `swipr.gas-grant.v1` | `project`, `day`, `subject`, `recipient`, `nonce` | Amount and transaction recovery information for bounded gas sponsorship | Funding service wallet; 180 days |

Source: [journal](../backend/arkiv-journal.ts), [renewal](../backend/arkiv-maintenance.ts), [gas funding](../backend/gas-funding.ts). Journal readers verify writer/owner, flags, consecutive revisions, nonce consistency and expiration before using the history. This is service-authored operational data, not an independent user-owned archive.

## Public writer addresses and a real entity

- Trader/profile writer: `0x11d7a223c96045b9B4C90d5907246cf86437F105`.
- Copier writer: `0xd5Dda1882302b3496922D1858C4386FE0eC3244d`.
- Operational journal/funding writer: `0x38ec73c5a31e444b3Eca9393b6b0d5191720b310`.
- Example trader entity: `0x590d444773afe232de63eaaff8ef8803940f3d34b80ea1fbfe62d11179281f8a`. Its `profile.image` references the [Swarm portrait](swarm.md).

Use the tested [README query](../README.md#arkiv-the-applications-database-with-wallet-ownership) to return entity keys, native owners, expiration blocks and attributes. Queries return current state; deletion or expiry can remove the example later.

## Expiration and deletion semantics

Entity storage expiration is separate from the pass's business deadline and the Privy signer's expiry. Expired/missing records are not treated as continuing authorization. `readonly` prevents content mutation but does not remove the owner's deletion power. Account deletion removes current user-owned entities before the Privy login; service records, public chain history and distributed media may remain.
