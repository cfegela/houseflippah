import assert from 'node:assert/strict';
import { getDelinquentProperties } from './src/delinquency.js';

console.log('🧪 Starting Turn-Start Delinquency Alert Unit Tests...\n');

const USER_ALICE = 'user-alice-123';
const USER_BOB = 'user-bob-456';

// 1. No properties owned -> empty
console.log('1. Testing user with no owned properties...');
assert.deepEqual(getDelinquentProperties(USER_ALICE, [], 4), []);
console.log('   ✓ User with no properties returns empty list.');

// 2. Current mortgage (missed_payments = 0) -> not delinquent
console.log('2. Testing user with current mortgages (0 missed payments)...');
const currentProps = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, missed_payments: 0, last_paid_round: 3 }
];
assert.deepEqual(getDelinquentProperties(USER_ALICE, currentProps, 4), []);
console.log('   ✓ Up-to-date mortgage is not flagged as delinquent.');

// 3. Delinquent mortgage (missed_payments = 1, last_paid_round < currentRound)
console.log('3. Testing delinquent mortgage detection...');
const delinquentProps = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, missed_payments: 1, last_paid_round: 2 },
  { property_slug: 'baltic_avenue', owner_user_id: USER_ALICE, missed_payments: 0, last_paid_round: 3 },
  { property_slug: 'oriental_avenue', owner_user_id: USER_BOB, missed_payments: 1, last_paid_round: 2 } // Belongs to Bob
];
const aliceDelinquent = getDelinquentProperties(USER_ALICE, delinquentProps, 4);
assert.equal(aliceDelinquent.length, 1);
assert.equal(aliceDelinquent[0].property_slug, 'mediterranean_avenue');
console.log('   ✓ Successfully identified Alice’s delinquent property while ignoring Bob’s and current ones.');

// 4. Delinquent mortgage already paid this round -> not flagged again
console.log('4. Testing delinquent mortgage paid for current round...');
const paidThisRound = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, missed_payments: 1, last_paid_round: 4 }
];
assert.deepEqual(getDelinquentProperties(USER_ALICE, paidThisRound, 4), []);
console.log('   ✓ Delinquent mortgage that already made payment for Round 4 is not flagged.');

// 5. Property sold to buyer (is_sold_to_buyer = true) -> not delinquent
console.log('5. Testing property sold to buyer is not flagged as delinquent...');
const soldProps = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, missed_payments: 1, last_paid_round: 2, is_sold_to_buyer: true }
];
assert.deepEqual(getDelinquentProperties(USER_ALICE, soldProps, 4), []);
console.log('   ✓ Sold property with is_sold_to_buyer=true is not flagged as delinquent.');

// 6. Property with mortgage balance cleared ($0) -> not delinquent
console.log('6. Testing property with mortgage balance cleared ($0) is not flagged...');
const clearedMortgageProps = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, missed_payments: 1, last_paid_round: 2, mortgage_balance: 0 }
];
assert.deepEqual(getDelinquentProperties(USER_ALICE, clearedMortgageProps, 4), []);
console.log('   ✓ Property with mortgage balance $0 is not flagged as delinquent.');

// 7. Property sold to automated buyer in propertySales during round transition -> not delinquent
console.log('7. Testing property sold to automated buyer during round transition...');
const staleProps = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, missed_payments: 1, last_paid_round: 2, mortgage_balance: 40000 }
];
const transitionSales = [
  { property_slug: 'mediterranean_avenue', seller_user_id: USER_ALICE, round_number: 3, buyer_type: 'automated' }
];
assert.deepEqual(getDelinquentProperties(USER_ALICE, staleProps, 4, transitionSales), []);
console.log('   ✓ Property sold in round transition sales history is not flagged as delinquent.');

// 8. Multiple properties: one sold during automated buying, one unsold and delinquent
console.log('8. Testing multiple properties: sold property ignored, unsold delinquent property flagged...');
const mixedProps = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, missed_payments: 1, last_paid_round: 2, mortgage_balance: 0, is_sold_to_buyer: true },
  { property_slug: 'baltic_avenue', owner_user_id: USER_ALICE, missed_payments: 1, last_paid_round: 2, mortgage_balance: 50000 }
];
const mixedDelinquent = getDelinquentProperties(USER_ALICE, mixedProps, 4);
assert.equal(mixedDelinquent.length, 1);
assert.equal(mixedDelinquent[0].property_slug, 'baltic_avenue');
console.log('   ✓ Correctly flags only the unsold delinquent property while ignoring the sold property.');

console.log('\n🎉 ALL DELINQUENCY ALERT UNIT TESTS PASSED PERFECTLY!\n');
