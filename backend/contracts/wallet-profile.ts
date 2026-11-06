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
