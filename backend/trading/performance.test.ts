import { expect, it } from 'vitest';
import { closedPositions, ghostResult, type VerifiedFill } from './performance';
const wallet = `0x${'11'.repeat(20)}`;
const fill = (n: number, side: string, cash: string, units: string): VerifiedFill => ({ txHash: `0x${n.toString(16).padStart(64,'0')}`, asset:'WETH', side, usdcMicros:cash, assetUnits:units, blockNumber:n, transactionIndex:0, timestamp:1000*n });
it('uses FIFO cost on partial exits and reconciles rounding on the final exit',()=>{
 const fills=[fill(1,'buy','5000001','10'),fill(2,'sell','3000000','5'),fill(3,'sell','4000000','5')];
 const p=closedPositions(fills,wallet,'copier','Copier');
 expect(p.map(p=>p.costUsdMicros)).toEqual(['2500000','2500001']);
 expect(p.map(p=>p.proceedsUsdMicros)).toEqual(['3000000','4000000']);
});
it('does not count open buys, unknown inventory, duplicate receipts or malformed values as profit',()=>{
 expect(closedPositions([fill(1,'buy','5000000','10')],wallet,'trader','Trader')).toEqual([]);
 expect(closedPositions([fill(1,'sell','5000000','10')],wallet,'trader','Trader')).toEqual([]);
 const b=fill(1,'buy','5000000','10'),s=fill(2,'sell','6000000','10');
 expect(closedPositions([s,b,b,s],wallet,'trader','Trader')).toHaveLength(1);
 expect(closedPositions([b,{...s,assetUnits:'-1'}],wallet,'trader','Trader')).toEqual([]);
});
it('bounds ghost prices by its real window and scales its buys and proportional exits',()=>{
 const ghost={traderId:'trader',startedAt:2000,expiresAt:5000,perTradeUsd:10,includedSignalId:null};
 const result=ghostResult(ghost,[fill(1,'buy','5000000','10'),fill(2,'buy','5000000','10'),fill(3,'sell','3000000','5'),fill(4,'sell','4000000','5'),fill(5,'buy','5000000','10')]);
 expect(result).toMatchObject({buys:1,closedTrades:2,openTrades:0,realizedPnlUsd:'4.000000',investedUsd:'10.000000'});
});
it('leaves open simulated inventory unpriced and does not import a pre-ghost cost basis',()=>{
 const ghost={traderId:'trader',startedAt:2000,expiresAt:5000,perTradeUsd:5,includedSignalId:null};
 expect(ghostResult(ghost,[fill(1,'buy','5000000','10'),fill(2,'sell','6000000','10'),fill(3,'buy','5000000','10')]))
 .toMatchObject({buys:1,closedTrades:0,openTrades:1,realizedPnlUsd:'0.000000'});
});
