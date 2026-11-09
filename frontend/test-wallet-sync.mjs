import { getPendingSalesProceeds, getDisplayCash } from './src/wallet.js';

console.log('\n🧪 Starting Wallet Balance Turn-Sync Unit Tests...\n');

// Test 1: Round 1 starting cash
console.log('1. Testing Round 1 starting cash (no pending sales)...');
const p1 = { user_id: 'user-seat-2', cash: 100000 };
const salesR1 = [];
const pendingR1 = getPendingSalesProceeds(p1.user_id, 1, 0, salesR1);
const displayR1 = getDisplayCash(p1, 1, 0, salesR1);
if (pendingR1 !== 0) throw new Error(`Expected 0 pending, got ${pendingR1}`);
if (displayR1 !== 100000) throw new Error(`Expected 100,000 display cash, got ${displayR1}`);
console.log('   ✓ Round 1 displays exact cash balance ($100,000).');

// Test 2: Round 2 begins, Seat 2 property sold in Round 1 transition, turn not yet started
console.log('2. Testing Round 2 before Seat 2 turn (unacknowledged sale proceeds withheld)...');
const p2 = { user_id: 'user-seat-2', cash: 145000 };
const salesR2 = [
  {
    buyer_type: 'automated',
    round_number: 1,
    seller_user_id: 'user-seat-2',
    net_proceeds: 45000,
  },
  {
    buyer_type: 'automated',
    round_number: 1,
    seller_user_id: 'user-seat-1',
    net_proceeds: 30000,
  }
];
const pendingR2Before = getPendingSalesProceeds(p2.user_id, 2, 0, salesR2);
const displayR2Before = getDisplayCash(p2, 2, 0, salesR2);
if (pendingR2Before !== 45000) throw new Error(`Expected 45,000 pending, got ${pendingR2Before}`);
if (displayR2Before !== 100000) throw new Error(`Expected 100,000 display cash, got ${displayR2Before}`);
console.log('   ✓ Seat 2 wallet displays pre-sale $100,000 while Seat 1 is taking turn.');

// Test 3: Seat 2 turn begins and sales modal is acknowledged
console.log('3. Testing Round 2 at Seat 2 turn start (modal acknowledged)...');
const pendingR2After = getPendingSalesProceeds(p2.user_id, 2, 2, salesR2);
const displayR2After = getDisplayCash(p2, 2, 2, salesR2);
if (pendingR2After !== 0) throw new Error(`Expected 0 pending after ack, got ${pendingR2After}`);
if (displayR2After !== 145000) throw new Error(`Expected 145,000 display cash, got ${displayR2After}`);
console.log('   ✓ Seat 2 wallet immediately updates to $145,000 upon turn start & acknowledgment.');

// Test 4: Multiple sales in the same round transition
console.log('4. Testing multiple sales in single round transition...');
const p3 = { user_id: 'user-seat-3', cash: 200000 };
const salesMulti = [
  {
    buyer_type: 'automated',
    round_number: 2,
    seller_user_id: 'user-seat-3',
    net_proceeds: 40000,
  },
  {
    buyer_type: 'automated',
    round_number: 2,
    seller_user_id: 'user-seat-3',
    net_proceeds: 60000,
  }
];
const pendingMulti = getPendingSalesProceeds(p3.user_id, 3, 0, salesMulti);
const displayMultiBefore = getDisplayCash(p3, 3, 0, salesMulti);
if (pendingMulti !== 100000) throw new Error(`Expected 100,000 pending total, got ${pendingMulti}`);
if (displayMultiBefore !== 100000) throw new Error(`Expected 100,000 display cash, got ${displayMultiBefore}`);

const displayMultiAfter = getDisplayCash(p3, 3, 3, salesMulti);
if (displayMultiAfter !== 200000) throw new Error(`Expected 200,000 display cash, got ${displayMultiAfter}`);
console.log('   ✓ Multiple sales ($40k + $60k) withheld before turn ($100k) and credited at turn ($200k).');

// Test 5: Player with no sales
console.log('5. Testing player with no sales in round transition...');
const p4 = { user_id: 'user-seat-4', cash: 85000 };
const pendingNone = getPendingSalesProceeds(p4.user_id, 2, 0, salesR2);
const displayNone = getDisplayCash(p4, 2, 0, salesR2);
if (pendingNone !== 0) throw new Error(`Expected 0 pending, got ${pendingNone}`);
if (displayNone !== 85000) throw new Error(`Expected 85,000 display cash, got ${displayNone}`);
console.log('   ✓ Player with 0 sales displays unchanged cash balance ($85,000).');

console.log('\n🎉 ALL WALLET BALANCE TURN-SYNC UNIT TESTS PASSED PERFECTLY!\n');
