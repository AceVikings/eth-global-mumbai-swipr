import { it, expect } from 'vitest';
import { profileUpsert } from './validation';
const profile = { profileId: '00000000-0000-4000-8000-000000000001', operator: `0x${'12'.repeat(20)}`, name: 'Test trader', bio: '', style: 'Balanced', strategy: 'manual', assets: ['WETH'] };
it('allows separately bounded public and private seat capacities', () => {
  expect(profileUpsert({ ...profile, publicSeats: 3, privateSeats: 2 })).toMatchObject({ publicSeats: 3, privateSeats: 2 });
  for (const number of [-1, 101, 0.5, '3', null]) {
    if (number === null) continue;
    expect(() => profileUpsert({ ...profile, publicSeats: number })).toThrow();
    expect(() => profileUpsert({ ...profile, privateSeats: number })).toThrow();
  }
  expect(profileUpsert({ ...profile, publicSeats: 0, privateSeats: 0 })).toMatchObject({ publicSeats: 0, privateSeats: 0 });
});
