# How Swipr uses Arkiv

Network: **Rabdi**, chain **7794095**. SDK: **`@arkiv-network/sdk@1.0.1`**. Every application query is scoped to indexed `project = str('swipr-mumbai26')` and the relevant schema/owner.

| Feature | Arkiv mechanism | What the user sees | Source |
| --- | --- | --- | --- |
| Trader/bot directory | Query wallet-profile entities and validate native owner | Profiles, strategies, supported assets and public/private seat capacity | [profile reader](../backend/bots/wallet-directory.ts) |
| Profile editing | Wallet-signed create/patch; native owner check | Own a profile and change or halt it | [wallet writes](../frontend/src/lib/arkiv.ts) |
| Social following | Wallet-owned social entity containing the following list | Restore follows; narrow leaderboard results to followed wallets | [social reader](../backend/social/wallet.ts) |
| Ghost copying | Wallet-owned saved configuration | Resume a hypothetical portfolio in another browser | [ghost reader](../backend/ghosts/wallet.ts) |
| Public/private seats | Copier-owned readonly join terms and trader-owned invitations | Immediate public joining, private invitations and deterministic capacity checks | [seat directory](../backend/passes/seats.ts) |
| Automatic copying | Wallet-owned grant record plus a separately enforced Privy policy | A bounded, expiring permission the owner can revoke | [automation](../frontend/src/lib/automation.ts) |
| Budget and order recovery | Revision-checked, service-owned readonly journal | Avoid duplicate copies and preserve budget holds through uncertain responses/restarts | [journal](../backend/arkiv-journal.ts) |
| Account deletion | Enumerate native wallet-owned entities; wallet signs deletes | Remove current application records before login deletion | [account service](../backend/account.ts) |
| Uploaded portraits | `profile.image` contains a Swarm `bzz://` reference | Persist the portrait with the profile without storing the file bytes in Arkiv | [Swarm evidence](swarm.md) |

## Fit of fields, authority and expiration

[Schema definitions and lifetimes](schema.md) list the actual fields. Indexed attributes support directory/schema/owner/status filtering; full structured payloads use `bytes` columns. Wallet identity is checked against native `$owner`, never accepted solely from the payload.

Profiles/social/ghost entities begin with a 30-day lifetime. Seats, invitations and automation records begin with 90 days. A ghost's simulation window, a pass's duration and a signer grant's expiry are validated separately and can end before the storage entity expires. Journal events begin at 180 days and support explicit renewal.

Readonly freezes join terms and journal payloads. It does **not** mean that the owner cannot delete a record, or that storage is permanent.

## Read/write demonstration

1. Sign in at the live app and save a profile, following list or ghost; approve the wallet's data transaction.
2. Reload or sign into the same wallet in another browser. The app reads the saved record from Arkiv.
3. Run the [README query](../README.md#arkiv-the-applications-database-with-wallet-ownership), changing the wallet filter for your own public address. Compare native owner and stored attributes.
4. For a new mutation, decline the wallet prompt: no confirmed data change should appear. Approve it to confirm the intended mutation.
5. Delete only your own disposable records through the account controls. Historical chain transactions remain public.

These mutation steps require the owning wallet's authorization. A third-party reader can run the public query without a Swipr login.

## Performance remains derived

Ghosts store settings, not invented profits. Their hypothetical entries/exits are reconstructed from receipt-verified wallet activity. Real leaderboards reconstruct closed positions from verified Base receipts and exclude ghost results. A profile or signal payload cannot manufacture a verified track record.
