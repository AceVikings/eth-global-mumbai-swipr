# Arkiv + Swarm: profile and bot media

## What is stored where

- **Swarm:** small static WebP portraits uploaded through Bee on the Sepolia Swarm testnet.
- **Arkiv:** wallet-owned profile data and the `bzz://` reference in the JSON **`profile.image`** field of `swipr.wallet-profile.v1`.
- **ENSv2:** the published `swipr.profile` snapshot can contain that same image reference.

This is platform media storage used by the actual interface. The shipped build does not claim a permanent trade archive, encrypted private media, two independent public gateways or a frontend hosted on Swarm.

## Real entity and content reference

| Item | Value |
| --- | --- |
| Arkiv entity | `0x590d444773afe232de63eaaff8ef8803940f3d34b80ea1fbfe62d11179281f8a` |
| Native profile owner | `0x11d7a223c96045b9B4C90d5907246cf86437F105` |
| Profile image | `bzz://222ffe30c36fd0fabaa270e155b2f12c2553e62e16335d40f0b6a343792f9ff3` |
| Postage batch | `bd66d161d39328076929422ef77123fab87058aff109cb4cda619597aa5280f3` |
| Batch purchaser / Bee wallet | `0x3cbf5e652b5dd077e55a7f06d417ef2efb257482` |
| Confirmed batch purchase | [Sepolia receipt](https://sepolia.etherscan.io/tx/0x896098902378dd3aa220bf62a464d97520885aac5ca96e11ed2df5ef71dc2f3c) |
| Upload service | Swipr's authenticated media API, backed by a team-operated Sepolia Bee node; direct Bee administration remains private |

**Open the content:** [Verified Swarm portrait read](https://swipr-api-4p35sr23vq-uc.a.run.app/api/media/222ffe30c36fd0fabaa270e155b2f12c2553e62e16335d40f0b6a343792f9ff3). [Discover](https://swipr-web.onrender.com/#discover) displays the bot's portrait. [The bot's ENS profile](https://sepolia.app.ens.domains/trader-a3288fdb4b7b4200.swipr.eth) publishes its linked profile. Run the [README query](../README.md#arkiv-the-applications-database-with-wallet-ownership) to inspect the Arkiv entity and decode `profile.image`.

The public media request used by the live frontend is `GET /api/media/<64-hex-reference>` on its configured API origin. Browser developer tools show the actual request; the response is a WebP with `X-Swarm-Reference` matching the requested address and `X-Swarm-Integrity: verified`. A fresh read of this reference returned HTTP 200 with integrity verified on 2026-11-07.

## One upload and one read

1. Open the live app and sign in through Privy. Use a wallet that owns a trader/bot profile, or create your own profile and approve its Arkiv transaction.
2. In **Bot studio → Edit**, select a portrait. The browser crops and converts it into a bounded static WebP. Only upload an image you are willing to make public.
3. The authenticated `POST /api/media` validates the linked wallet and image. Bee receives the bytes with the platform postage batch, pinning enabled and deferred upload disabled. The service checks the returned BMT address, reads the bytes back and verifies them before returning the reference.
4. Save the profile and approve the wallet's Arkiv write. Reload: the profile's `image` reference restores the portrait.
5. Inspect the resulting `GET /api/media/<ref>` response and headers. Compare the returned reference to the saved Arkiv field. This read is public; creating or changing the profile requires its owner's authorization.

For a local run, follow the README and configure your own Bee URL/postage batch alongside the wallet integrations. The application needs a usable batch and a reachable Bee node. Direct Bee credentials, node administration and project infrastructure identifiers are not required in this public guide.

## Code and verification

- [Browser portrait processing and upload](../frontend/src/lib/profile-images.ts).
- [API upload and public reads](../backend/api.ts).
- [File format, dimensions and upload readback](../backend/media.ts).
- [Bee upload/download and BMT file-address verification](../backend/providers/bee.ts).
- Run `npm test --prefix backend -- media.test.ts providers.test.ts bots/profile-image.test.ts` for format bounds, integrity mismatch rejection and profile reference preservation.

The **2:49 demo's media section starts at 2:21**. It shows the existing portrait and upload editor; it does not pretend that a new upload or profile transaction was submitted in that recorded segment. The steps above allow judges to perform a fresh authorized upload/read themselves.

## Friction

1. **Network matters:** public mainnet gateways are not a reliable route to Sepolia testnet content. The app uses its configured Sepolia Bee transport; a failed external gateway is not proof that the reference is invalid.
2. **A successful upload response is not enough:** Swipr verifies the content address and performs readback before storing the reference. Readback failure is shown as a failure, not a saved portrait.
3. **Integrity is not availability:** BMT verification detects wrong bytes; it does not promise that content remains reachable after postage expiry or node/network failure. Uploads request pinning, and the interface has a bundled-image fallback.
4. **Public references remain public:** removing an Arkiv profile reference does not erase copies of media already distributed. Encrypted 128-hex references are rejected by this public-media path rather than stored with their embedded key.
