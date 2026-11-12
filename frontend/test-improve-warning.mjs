import assert from 'node:assert/strict';
import { canImproveAnyProperties } from './src/improvements.js';

console.log('🧪 Starting Make Improvements Warning Unit Tests...\n');

const USER_ALICE = 'user-alice-123';
const USER_BOB = 'user-bob-456';

// 1. User with no properties owned
console.log('1. Testing user with no owned properties...');
assert.equal(canImproveAnyProperties(USER_ALICE, [], 1), false);
console.log('   ✓ User with no properties returns false (warning modal triggers).');

// 2. User with property purchased in the current round
console.log('2. Testing user with property purchased in the current round...');
const purchasedCurrentRound = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, purchased_round: 1, improvements: [], is_listed: false }
];
assert.equal(canImproveAnyProperties(USER_ALICE, purchasedCurrentRound, 1), false);
console.log('   ✓ Property purchased in current round returns false (warning modal triggers).');

// 3. User with property purchased in a previous round
console.log('3. Testing user with property purchased in a previous round...');
assert.equal(canImproveAnyProperties(USER_ALICE, purchasedCurrentRound, 2), true);
console.log('   ✓ Property purchased in previous round returns true (permits navigation to Make Improvements).');

// 4. User with mixed properties (one current round, one previous round)
console.log('4. Testing user with mixed purchase rounds...');
const mixedProps = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, purchased_round: 2, improvements: [], is_listed: false },
  { property_slug: 'baltic_avenue', owner_user_id: USER_ALICE, purchased_round: 1, improvements: ['windows_doors'], is_listed: false }
];
assert.equal(canImproveAnyProperties(USER_ALICE, mixedProps, 2), true);
console.log('   ✓ If at least one property was purchased in a previous round, returns true.');

// 5. User with property from previous round but actively listed
console.log('5. Testing user with actively listed property...');
const listedProps = [
  { property_slug: 'oriental_avenue', owner_user_id: USER_ALICE, purchased_round: 1, improvements: [], is_listed: true }
];
assert.equal(canImproveAnyProperties(USER_ALICE, listedProps, 2), false);
console.log('   ✓ Actively listed property returns false.');

// 6. User with property from previous round listed this round
console.log('6. Testing user with property listed in the current round...');
const listedThisRound = [
  { property_slug: 'oriental_avenue', owner_user_id: USER_ALICE, purchased_round: 1, improvements: [], is_listed: false, last_listed_round: 2 }
];
assert.equal(canImproveAnyProperties(USER_ALICE, listedThisRound, 2), false);
console.log('   ✓ Property listed in the same round returns false.');

// 7. User with property already max upgraded (5/5 improvements)
console.log('7. Testing user with max upgraded property (5/5)...');
const maxUpgradedProps = [
  {
    property_slug: 'boardwalk',
    owner_user_id: USER_ALICE,
    purchased_round: 1,
    improvements: ['windows_doors', 'hvac_mechanicals', 'roof_siding', 'flooring_painting', 'kitchen_baths'],
    is_listed: false
  }
];
assert.equal(canImproveAnyProperties(USER_ALICE, maxUpgradedProps, 2), false);
console.log('   ✓ Max upgraded property (5/5) returns false.');

// 8. User with sold property (is_sold_to_buyer = true)
console.log('8. Testing user with sold property...');
const soldProps = [
  { property_slug: 'park_place', owner_user_id: USER_ALICE, purchased_round: 1, improvements: [], is_listed: false, is_sold_to_buyer: true }
];
assert.equal(canImproveAnyProperties(USER_ALICE, soldProps, 2), false);
console.log('   ✓ Sold properties are excluded and return false.');

// 9. Isolation: other player properties ignored
console.log('9. Testing user ownership isolation...');
const otherPlayerProps = [
  { property_slug: 'boardwalk', owner_user_id: USER_BOB, purchased_round: 1, improvements: [], is_listed: false },
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, purchased_round: 2, improvements: [], is_listed: false }
];
assert.equal(canImproveAnyProperties(USER_ALICE, otherPlayerProps, 2), false);
assert.equal(canImproveAnyProperties(USER_BOB, otherPlayerProps, 2), true);
console.log('   ✓ Strictly checks current user properties only.');

// 10. Defensive handling of missing or invalid inputs
console.log('10. Testing defensive handling of missing / invalid inputs...');
assert.equal(canImproveAnyProperties(null, [], 1), false);
assert.equal(canImproveAnyProperties(USER_ALICE, null, 1), false);
assert.equal(canImproveAnyProperties(undefined, undefined, undefined), false);
console.log('   ✓ Safely handles undefined/null parameters.');

console.log('\n🎉 ALL MAKE IMPROVEMENTS WARNING UNIT TESTS PASSED PERFECTLY!\n');
