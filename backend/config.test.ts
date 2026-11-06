import { describe, it, expect } from 'vitest';
import { readConfig } from './config';

describe('automatic chain connections', () => {
  it('provides Base and Sepolia RPCs without user configuration', () => {
    const config = readConfig({});
    expect(config.baseRpc).toBe('https://mainnet.base.org');
    expect(config.sepoliaRpc).toBe('https://ethereum-sepolia-rpc.publicnode.com');
  });
  it('uses dedicated RPC overrides when supplied', () => {
    const config = readConfig({ BASE_RPC: 'https://base.example', SEPOLIA_RPC: 'https://sepolia.example' });
    expect(config.baseRpc).toBe('https://base.example');
    expect(config.sepoliaRpc).toBe('https://sepolia.example');
  });
});
