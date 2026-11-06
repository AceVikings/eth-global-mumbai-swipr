import {expect,it} from 'vitest';
import type {Journal,JournalEvent} from '../arkiv-journal';
import {CopyAccounting} from './accounting';
const seat={id:`0x${'11'.repeat(32)}`,owner:`0x${'22'.repeat(20)}`,expiresAt:Date.now()+60000,budgetVersion:1,terms:{perTradeUsd:5,tradeCount:1}} as any;
class TestJournal implements Journal {
 canWrite=true;events:JournalEvent[]=[];
 async read(){return {events:structuredClone(this.events),nonce:this.events.length,timestampMs:Date.now(),blockNumber:1n};}
 async append(e:JournalEvent,nonce:number){if(nonce!==this.events.length)throw Error('conflict');this.events.push(e);}
 async close(){}
}
it('serializes duplicate copies and preserves holds across service recreation',async()=>{
 const journal=new TestJournal(),store=new CopyAccounting(journal);
 const attempts=await Promise.all([store.reserve(seat,'source','quote',5000000n),store.reserve(seat,'source','quote',5000000n)]);
 expect(attempts.filter(a=>a.created)).toHaveLength(1);
 const restored=new CopyAccounting(journal);
 await expect(restored.reserve(seat,'source2','quote2',5000000n)).rejects.toThrow('budget');
 expect((await restored.reserve(seat,'source','quote',5000000n)).created).toBe(false);
 await store.submitted('quote','order');expect((await restored.reserve(seat,'source','quote',5000000n)).orderId).toBe('order');
 expect(JSON.stringify(journal.events)).not.toContain('signature');
});
it('does not release uncertain submissions and only releases confirmed unfilled terminals',async()=>{
 const journal=new TestJournal(),store=new CopyAccounting(journal);await store.reserve(seat,'s','q',5000000n);await store.submitted('q','order');
 await store.reconcile('order',false,0n);await expect(store.reserve(seat,'s2','q2',5000000n)).rejects.toThrow('budget');
 await store.reconcile('order',true,0n);expect((await store.reserve(seat,'s2','q2',5000000n)).created).toBe(true);
});
it('enforces chain time, exact frozen size and pass lifetime',async()=>{
 const store=new CopyAccounting(new TestJournal());
 await expect(store.reserve({...seat,expiresAt:0},'s','q',5000000n)).rejects.toThrow('expired');
 await expect(store.reserve(seat,'s','q',6000000n)).rejects.toThrow('size');
});

it('leaves the shared engine ledger replayable after real copy reservations',async()=>{
 const {Ledger}=await import('../ledger');const journal=new TestJournal();
 await new CopyAccounting(journal).reserve(seat,'source','quote',5000000n);
 const ledger=await Ledger.open(journal);expect((await ledger.health()).ok).toBe(true);
 await ledger.enqueueJob('probe-base',{});expect(journal.events).toHaveLength(2);
});

it('refuses legacy passes whose earlier fills were never journaled',async()=>{
 const store=new CopyAccounting(new TestJournal());
 await expect(store.reserve({...seat,budgetVersion:undefined},'s','q',5000000n)).rejects.toThrow('Rejoin');
});
