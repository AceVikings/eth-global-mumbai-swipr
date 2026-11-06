import { defineSchema, str } from '@arkiv-network/sdk/schema';

// Contents are user-editable. Native $owner is the sole profile authority.
// Performance, receipts and rankings never come from this schema.
export const WALLET_PROFILE_PROJECT = 'swipr-mumbai26';
export const WALLET_PROFILE_SCHEMA = 'swipr.wallet-profile.v1';
export const WalletProfileSchema = defineSchema(WALLET_PROFILE_SCHEMA, {
  project: str().indexed(), profile: str(), status: str().indexed(),
});
