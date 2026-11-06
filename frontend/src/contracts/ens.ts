import { parseAbi, toHex } from 'viem';
import { normalize, packetToBytes } from 'viem/ens';
// Canonical ENSv2 Sepolia deployment: https://docs.ens.domains/learn/deployments/
export const ENS_CHAIN_ID = 11155111;
export const ENS = {
 universal: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
 registrar: '0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3',
 registry: '0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4',
 factory: '0xda70306c98e97ece36f997a21368e53298572991',
 resolverImpl: '0x115eb53f0c60696633855f90b138178fb40b2b2c',
 registryImpl: '0x9bd8a88719068d09ecee662f36c0e3856708366a',
 paymentToken: '0x240b0316df57887dbbe58b586508b19e633a14aa', // gitleaks:allow -- public Sepolia MockUSDC contract address
} as const;
export const resolverAbi = parseAbi([
 'function grantSetterRoles(bytes setter,address account) returns (bool)',
 'function revokeRootRoles(uint256 roleBitmap,address account) returns (bool)',
 'function roles(uint256 resource,address account) view returns (uint256)',
 'function supportsInterface(bytes4) view returns (bool)',
 'function initialize((address account,uint256 roleBitmap)[] grants,bytes[] calls)',
 'function setText(bytes name,string key,string value)',
 'function setAddress(bytes name,uint256 coinType,bytes addressBytes)',
 'function multicall(bytes[] calls) returns (bytes[])',
]);
export const universalAbi = parseAbi([
 'function findResolver(bytes name) view returns (address resolver,bytes32 node,uint256 offset)',
 'function resolve(bytes name,bytes data) view returns (bytes,address)',
]);
export const profileAbi = parseAbi(['function text(bytes32 node,string key) view returns (string)', 'function addr(bytes32 node) view returns (address)']);
export const registryAbi = parseAbi(['function getTokenId(uint256) view returns (uint256)', 'function ownerOf(uint256) view returns (address)', 'function getStatus(uint256) view returns (uint8)', 'function getExpiry(uint256) view returns (uint64)']);
export const subregistryAbi = parseAbi([
 'function initialize((address account,uint256 roleBitmap)[] grants)',
 'function register(string label,address owner,address registry,address resolver,uint256 roleBitmap,uint64 expiry) returns (uint256)',
 'function getSubregistry(string label) view returns (address)',
 'function setSubregistry(uint256 anyId,address registry)',
]);
export const factoryAbi = parseAbi(['function deployProxy(address implementation,uint256 salt,bytes data) returns (address)', 'function predictProxyAddress(address deployer,uint256 salt) view returns (address)']);
export const registrarAbi = parseAbi([
 'function makeCommitment(string label,address owner,bytes32 secret,address subregistry,address resolver,uint64 duration,bytes32 referrer) pure returns (bytes32)',
 'function commit(bytes32 commitment)',
 'function commitmentAt(bytes32) view returns (uint256)',
 'function MIN_COMMITMENT_AGE() view returns (uint256)',
 'function register(string label,address owner,bytes32 secret,address subregistry,address resolver,uint64 duration,address paymentToken,bytes32 referrer) returns (uint256)',
]);
export const ENS_KEYS = ['swipr.profile','swipr.stats','swipr.updatedAt','description'] as const;
export function ensName(value: unknown): string {
 if (typeof value !== 'string' || value.length > 255) throw new Error('Enter a Sepolia ENS name.');
 const name=normalize(value.trim());
 const labels=name.split('.');
 if(labels.length<2||labels.length>6||labels.at(-1)!=='eth'||!labels.slice(0,-1).every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Use an .eth name or subname with letters, numbers and hyphens.');
 return name;
}
export const dnsName = (name: string) => toHex(packetToBytes(ensName(name)));
export type EnsStats = { state:'verified'|'unavailable'; scope?:'latest20Orders'; attribution?:'wallet'; wallet?:string; hasMore?:boolean; fills?: {orderId:string;txHash:string;side:string;asset:string;usdcMicros:string;assetUnits:string}[]; realizedPnlUsd:null };
export type EnsProof = {name:string;chainId:number;resolver:string;owner:string;identityVerified:boolean;profileMatches:boolean;statsVerified:boolean;fresh:boolean;records:Record<string,string>};
export type EnsTransaction = {to:`0x${string}`;data:`0x${string}`;value:'0x0';chainId:number};
