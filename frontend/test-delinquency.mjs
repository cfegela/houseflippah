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

console.log('\n🎉 ALL DELINQUENCY ALERT UNIT TESTS PASSED PERFECTLY!\n');
