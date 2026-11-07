import { expect, it } from 'vitest';
import type { Journal, JournalEvent } from '../arkiv-journal';
import { PassBook, portfolio, profitShare } from './pass-book';
import { CopyAccounting } from './accounting';
import { Ledger } from '../ledger';
const seatId = `0x${'11'.repeat(32)}`, tx = (n: number) => `0x${n.toString(16).padStart(64,'0')}`;
class Memory implements Journal {
 canWrite = true; events: JournalEvent[] = [];
 async read() { return { events: structuredClone(this.events), nonce: this.events.length, timestampMs: Date.now(), blockNumber: 1n }; }
 async append(e: JournalEvent, nonce: number) { if (nonce !== this.events.length) throw Error('conflict'); this.events.push(e); }
 async close() {}
}
const buy = { txHash: tx(1), asset: 'WETH' as const, side: 'buy' as const, units: '100', cash: '5000000' };
it('persists attributed units, reserves once across replicas and reconciles partial exits', async () => {
 const journal = new Memory(), book = new PassBook(journal);
 await book.fill(seatId, 'buy', buy); await book.fill(seatId, 'buy', buy);
 const attempts = await Promise.all([book.reserve(seatId,'q','WETH',60n,'cashout'),new PassBook(journal).reserve(seatId,'q','WETH',60n,'cashout')]);
 expect(attempts.filter(x=>x.created)).toHaveLength(1);
 await expect(book.reserve(seatId,'other','WETH',50n,'other')).rejects.toThrow('inventory');
 await book.submitted('q','sell');
 await book.fill(seatId,'sell',{...buy,txHash:tx(2),side:'sell',units:'40',cash:'2400000'});
 await expect(book.fill(seatId,'sell',{...buy,txHash:tx(3),side:'sell',units:'30',cash:'1800000'})).rejects.toThrow('reservation');
 await book.terminal('sell');
 const state = await new PassBook(journal).state(seatId), p = portfolio(state);
 expect(p.positions.get('WETH')).toEqual({units:60n,cost:3000000n}); expect(p.realized).toBe(400000n);
 expect(await book.reserve(seatId,'retry','WETH',60n,'cashout')).toEqual({created:true});
 expect((await Ledger.open(journal)).health()).resolves.toMatchObject({ok:true});
});
it('keeps unknown exit holds and prevents receipt reuse by another pass', async () => {
 const book = new PassBook(new Memory()); await book.fill(seatId,'buy',buy);
 await expect(book.fill(tx(9),'other',buy)).rejects.toThrow('conflict');
 await book.reserve(seatId,'q','WETH',100n,'cashout');
 await expect(book.reserve(seatId,'q2','WETH',1n,'stop')).rejects.toThrow('inventory');
 await expect(book.fill(seatId,'unreserved',{...buy,txHash:tx(2),side:'sell'})).rejects.toThrow('reservation');
});
it('drawdown pauses new reservations durably without resuming when prices recover', async () => {
 const journal = new Memory(), book = new PassBook(journal), accounting = new CopyAccounting(journal);
 await book.mark(seatId,2000000n,1000000n); await book.mark(seatId,1000000n,1000000n);
 await book.mark(seatId,3000000n,1000000n);
 expect(await new PassBook(journal).state(seatId)).toMatchObject({paused:true,highWater:3000000n});
 const seat={id:seatId,owner:`0x${'22'.repeat(20)}`,budgetVersion:1,expiresAt:Date.now()+60000,terms:{perTradeUsd:5,tradeCount:2}} as any;
 expect(await accounting.available(seat)).toBe(false);
 await expect(accounting.reserve(seat,'s','q',5000000n)).rejects.toThrow('paused');
});
it('settles only a closed ended pass, waives losses and fees under five cents, and rejects duplicate payments', async () => {
 expect(profitShare(-1000000n)).toBe(0n); expect(profitShare(999999n)).toBe(0n); expect(profitShare(1000000n)).toBe(50000n);
 const book = new PassBook(new Memory()); await book.fill(seatId,'buy',buy);
 await book.mark(seatId,0n,1000000n,true);
 await expect(book.settle(seatId,0n,null)).rejects.toThrow('Close');
 await book.reserve(seatId,'q','WETH',100n,'cashout'); await book.submitted('q','sell');
 await book.fill(seatId,'sell',{...buy,txHash:tx(2),side:'sell',cash:'7000000'}); await book.terminal('sell');
 await expect(book.settle(seatId,0n,null)).rejects.toThrow('Close');
 await book.settle(seatId,100000n,tx(3)); await book.settle(seatId,100000n,tx(3));
 await expect(book.settle(seatId,100000n,tx(4))).rejects.toThrow('conflict');
});
