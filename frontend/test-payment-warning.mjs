import assert from 'node:assert/strict';
import { hasPayableMortgages } from './src/mortgages.js';

console.log('🧪 Starting Make Payments Warning Unit Tests...\n');

const USER_ALICE = 'user-alice-123';
const USER_BOB = 'user-bob-456';

// 1. User with no properties owned
console.log('1. Testing user with no owned properties...');
assert.equal(hasPayableMortgages(USER_ALICE, []), false);
console.log('   ✓ User with no properties returns false (warning modal triggers).');

// 2. User with owned properties
console.log('2. Testing user with owned properties...');
const ownedProps = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, is_sold_to_buyer: false }
];
assert.equal(hasPayableMortgages(USER_ALICE, ownedProps), true);
console.log('   ✓ User with owned property returns true (permits navigation to Make Payments).');

// 3. User with only sold properties
console.log('3. Testing user with only sold properties...');
const soldProps = [
  { property_slug: 'baltic_avenue', owner_user_id: USER_ALICE, is_sold_to_buyer: true }
];
assert.equal(hasPayableMortgages(USER_ALICE, soldProps), false);
console.log('   ✓ User with only sold properties returns false.');

// 4. Isolation: other player properties ignored
console.log('4. Testing user ownership isolation...');
const otherPlayerProps = [
  { property_slug: 'boardwalk', owner_user_id: USER_BOB, is_sold_to_buyer: false }
];
assert.equal(hasPayableMortgages(USER_ALICE, otherPlayerProps), false);
assert.equal(hasPayableMortgages(USER_BOB, otherPlayerProps), true);
console.log('   ✓ Strictly checks current user properties only.');

// 5. Defensive handling of missing or invalid inputs
console.log('5. Testing defensive handling of missing / invalid inputs...');
assert.equal(hasPayableMortgages(null, []), false);
assert.equal(hasPayableMortgages(USER_ALICE, null), false);
assert.equal(hasPayableMortgages(undefined, undefined), false);
console.log('   ✓ Safely handles undefined/null parameters.');

console.log('\n🎉 ALL MAKE PAYMENTS WARNING UNIT TESTS PASSED PERFECTLY!\n');
