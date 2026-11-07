import { defineSchema, str, bytes } from '@arkiv-network/sdk/schema';

// Contents are user-editable. Native $owner is the sole profile authority.
// Performance, receipts and rankings never come from this schema.
export const WALLET_PROFILE_PROJECT = 'swipr-mumbai26';
export const WALLET_PROFILE_SCHEMA = 'swipr.wallet-profile.v1';
export const WalletProfileSchema = defineSchema(WALLET_PROFILE_SCHEMA, {
  project: str().indexed(), profile: bytes(), status: str().indexed(),
});

export const WALLET_SOCIAL_SCHEMA = 'swipr.wallet-social.v1';
export const WalletSocialSchema = defineSchema(WALLET_SOCIAL_SCHEMA, {
  project: str().indexed(), following: bytes(),
});

/** JSON belongs in Arkiv bytes columns; text columns are capped at 128 UTF-8 bytes. */
export const walletJson = (value: unknown) => bytes(new TextEncoder().encode(JSON.stringify(value)));

export const WALLET_SIGNAL_SCHEMA = 'swipr.wallet-signal.v1';
export const WalletSignalSchema = defineSchema(WALLET_SIGNAL_SCHEMA, {
  project: str().indexed(), profileId: str().indexed(), signal: bytes(),
});

export const WALLET_GHOST_SCHEMA = 'swipr.wallet-ghost.v1';
export const WalletGhostSchema = defineSchema(WALLET_GHOST_SCHEMA, {
  project: str().indexed(), ghost: bytes(), status: str().indexed(),
});

export const WALLET_SEAT_SCHEMA = 'swipr.wallet-seat.v1';
export const WalletSeatSchema = defineSchema(WALLET_SEAT_SCHEMA, {
  project: str().indexed(), join: bytes(),
});
export const WALLET_SEAT_INVITE_SCHEMA = 'swipr.wallet-seat-invite.v1';
export const WalletSeatInviteSchema = defineSchema(WALLET_SEAT_INVITE_SCHEMA, {
  project: str().indexed(), profileId: str().indexed(), invitee: str().indexed(), status: str().indexed(),
});

export const WALLET_AUTOMATION_SCHEMA = 'swipr.wallet-automation.v1';
export const WalletAutomationSchema = defineSchema(WALLET_AUTOMATION_SCHEMA, {
  project: str().indexed(), grant: bytes(),
});

export const WalletSettlementSchema = defineSchema('swipr.wallet-settlement.v1', {
  project: str().indexed(), seatId: str().indexed(), receipt: bytes(),
});
