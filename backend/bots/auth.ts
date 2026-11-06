import { createHash } from 'node:crypto';
import { recoverMessageAddress } from 'viem';
import { botMessage, type BotAction } from '../../shared/bots';
import { BotError, parseEnvelope } from './validation';

export type VerifiedAction = { payload: BotAction; actor: string; digest: string };

/**
 * Recovers the EOA that personal_signed (EIP-191) botMessage(payload). The signature
 * itself is dropped here; only the actor and a sha256 digest of the message (used for
 * exact-replay detection) continue to storage. Smart-contract wallets (EIP-1271) are not supported.
 */
export async function verifyBotAction(raw: unknown, audience: string): Promise<VerifiedAction> {
  const { payload, signature } = parseEnvelope(raw, audience);
  const message = botMessage(payload);
  let actor: string;
  try {
    actor = (await recoverMessageAddress({ message, signature })).toLowerCase();
  } catch (cause) {
    throw new BotError('unauthorized', 'signature could not be verified', { cause });
  }
  if (/^0x0{40}$/.test(actor)) throw new BotError('unauthorized', 'signature could not be verified');
  return { payload, actor, digest: `0x${createHash('sha256').update(message).digest('hex')}` };
}
