# Bot integration (REST + MCP)

Swipr lets a trader register **their own** bot, then lets that bot publish signals. A
signal is a *proposal* (asset, side, quantity, limit price, optional thesis). It is not
an order, does not move funds, and is never shown as a fill or as performance.

Trading is disabled (`tradingEnabled: false`) until the verified pass, signer and
receipt gates pass. Order tools exist so the interface is stable, but the host rejects
them for now.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/bots` | `{ profiles, signals, state, detail }`. Read-only. |
| `GET /api/bots/integration` | `{ audience, mcpUrl, apiUrl, tools, tradingEnabled: false }`. |
| `POST /api/bots/commands` | Body is a raw `SignedBotAction`. |
| `POST /api/agent` | Body `{ "tool": string, "arguments": object }`. Same dispatcher as MCP. |
| `POST /mcp` | Stateless MCP over JSON-RPC 2.0, protocol `2025-03-26`. |

Both `/api/agent` and `/mcp` call `createBotGateway(deps)` in `server/bots/gateway.ts`.
The tool names, input schemas, validation and errors are identical on both.

## Owner vs operator

- **Owner** is the wallet that signs `profile.upsert` and `profile.halt`. The first
  upsert creates the profile. The owner is the recovered signer, never a field you send.
- **Operator** is the address named in the profile (`data.operator`). Only the operator
  can sign `signal.publish` for that profile. Use a separate hot key for the operator
  so the owner key can stay in a hardware or browser wallet.
- Owner and operator may be the same address. The server never holds either key.

Neither role implies ERC-8004 or ENS verification. They are just signer addresses.

## Signing a `SignedBotAction`

```ts
type BotAction = {
  version: 1;
  audience: string;      // exactly the value from GET /api/bots/integration
  chainId: 8453;
  requestId: string;     // fresh UUID per new action
  issuedAt: number;      // unix seconds
  expiresAt: number;     // unix seconds, at most 300s after issuedAt
  action: 'profile.upsert' | 'profile.halt' | 'signal.publish';
  data: object;
};
type SignedBotAction = { payload: BotAction; signature: `0x${string}` }; // EIP-191 personal_sign
```

The wallet signs `botMessage(payload)` from `shared/bots.ts`. The message has these lines,
joined by `\n`:

```
Swipr bot action (no funds move; signals are proposals only)
version: 1
audience: <audience>
chainId: 8453
requestId: <uuid>
issuedAt: <seconds>
expiresAt: <seconds>
action: <action>
data: <data as JSON with object keys sorted recursively, undefined keys dropped>
```

Rules the worker enforces:

- The signature must recover to the owner (upsert/halt) or the operator (publish).
- Freshness is checked against confirmed chain time, so keep the window short (60–300s).
- `requestId` gives durable replay protection. Resending the exact same envelope returns
  the original result with `replayed: true`. Reusing a `requestId` with a different
  payload is rejected as a conflict.
- Signatures are verified and then dropped. They are never written to Arkiv.

### Action data

| Action | `data` | Signer |
| --- | --- | --- |
| `profile.upsert` | `{ profileId?, operator, name, bio?, style: 'Steady'\|'Balanced'\|'Spicy', strategy: 'rule-based'\|'llm'\|'manual', assets: ('WETH'\|'cbBTC')[] }`. Leave out `profileId` to create; the new ID is the `requestId`. | owner |
| `profile.halt` | `{ profileId }` | owner |
| `signal.publish` | `{ profileId, asset, side: 'buy'\|'sell', quantity, limitPrice, thesis? }`. Amounts are positive plain decimal strings. | operator |

Unknown fields are rejected. A halted profile rejects every new signal.

### Node example (viem)

```ts
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { botMessage, type BotAction } from './shared/bots';

const api = process.env.SWIPR_API ?? 'http://127.0.0.1:8787';
const operator = privateKeyToAccount(process.env.BOT_OPERATOR_KEY as `0x${string}`);
const { audience } = await (await fetch(`${api}/api/bots/integration`)).json();

const now = Math.floor(Date.now() / 1000);
const payload: BotAction = {
  version: 1, audience, chainId: 8453, requestId: randomUUID(),
  issuedAt: now, expiresAt: now + 120, action: 'signal.publish',
  data: { profileId: process.env.BOT_PROFILE_ID!, asset: 'WETH', side: 'buy', quantity: '0.01', limitPrice: '3000' },
};
const signedAction = { payload, signature: await operator.signMessage({ message: botMessage(payload) }) };

// Either post the raw envelope ...
await fetch(`${api}/api/bots/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedAction) });
// ... or call the same action through the tool dispatcher.
await fetch(`${api}/api/agent`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tool: 'swipr_publish_signal', arguments: { signedAction } }) });
```

To register a bot, the **owner** wallet signs a `profile.upsert`. In the browser, use
`window.ethereum.request({ method: 'personal_sign', params: [botMessage(payload), owner] })`.

### curl

curl can't sign, so build the envelope with the Node snippet above (or the Bots page),
save it to `signed.json`, and send it:

```sh
curl -s "$SWIPR_API/api/bots/integration"
curl -s "$SWIPR_API/api/bots"

curl -s -X POST "$SWIPR_API/api/bots/commands" -H 'content-type: application/json' --data @signed.json

jq '{tool: "swipr_halt_bot", arguments: {signedAction: .}}' signed.json |
  curl -s -X POST "$SWIPR_API/api/agent" -H 'content-type: application/json' --data @-

curl -s -X POST "$SWIPR_API/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## MCP client config

The server is stateless and has no `Mcp-Session-Id`. Every POST is answered with a single
JSON body, and notifications get `202` with no body.

Claude Code:

```sh
claude mcp add --transport http swipr "$SWIPR_API/mcp"
```

Generic `mcpServers` JSON:

```json
{ "mcpServers": { "swipr": { "type": "http", "url": "https://<api-host>/mcp" } } }
```

Your agent still has to sign envelopes with its own operator key and pass them as
`arguments.signedAction`. The MCP server can't sign for you and has no trusted-caller mode.

## Tools

| Tool | Arguments | Notes |
| --- | --- | --- |
| `swipr_list_bots` | `{}` | Read-only. |
| `swipr_register_bot` | `{ signedAction }` with action `profile.upsert` | Owner-signed. |
| `swipr_halt_bot` | `{ signedAction }` with action `profile.halt` | Owner-signed. Stops new signals. |
| `swipr_publish_signal` | `{ signedAction }` with action `signal.publish` | Operator-signed proposal. |
| `flash_quote` | `{ side, asset, qty, funder, limitPrice }` | Indicative quote only. |
| `flash_get_order` | `{ orderId, funder }` | Provider-reported status. |
| `flash_submit_order` | `{ quoteId, funder, signature }` | Relays a quote the funder already signed (EIP-712). Rejected while trading is disabled. |
| `swipr_seal_fill` | `{ orderId, funder, txHash }` | The fill comes from provider status plus the Base receipt. Caller claims aren't trusted. |
| `set_ens_text` | `{ name, key, value }` | Returns unsigned calldata. Nothing is broadcast. |

Every input schema sets `additionalProperties: false`. A tool whose envelope action
doesn't match it (for example a `profile.upsert` sent to `swipr_halt_bot`) is rejected
before anything reaches the worker.

## Halting

The owner signs `profile.halt` with `{ profileId }`. After that the profile reads
`status: 'halted'`, and every later `signal.publish` for it is rejected, whoever signs
it. Signals already published stay in history as proposals.

## Signals vs fills

| | Signal | Fill |
| --- | --- | --- |
| Produced by | Operator-signed `signal.publish` | Flash order status plus a Base settlement receipt |
| Moves funds | No | Yes (only after gates are enabled) |
| Shown as | Proposal | Sealed fill with tx hash |
| Proves performance | No | Only with receipt evidence |

The UI and API never turn a signal into a fill, a PnL figure or a verified badge.

## Errors

- **MCP protocol errors** are JSON-RPC errors: `-32700` parse error (the host sends
  `PARSE_ERROR_BODY` with HTTP 400), `-32600` invalid request (HTTP 400), `-32601`
  unknown method, `-32602` invalid params or unknown tool name.
- **Tool failures** (bad arguments, a rejected signature, a disabled provider) come back
  as a normal `tools/call` result with `isError: true` and
  `content[0].text = {"error":{"code","message"}}`.
- **REST `/api/agent`** returns `{ tool, result }` with 200. Otherwise it returns
  `{ error: { code, message } }` with 400 (invalid), 404 (unknown tool), the dependency's
  status (for example 503 `execution_unavailable`), 502 (provider failure) or 503.
  Provider and internal error details are never echoed.
