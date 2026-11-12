import assert from 'node:assert/strict';
import { canListAnyProperties } from './src/listing.js';

console.log('🧪 Starting Sell Properties Unimproved Warning Unit Tests...\n');

const USER_ALICE = 'user-alice-123';
const USER_BOB = 'user-bob-456';

// 1. User with no properties owned
console.log('1. Testing user with no owned properties...');
assert.equal(canListAnyProperties(USER_ALICE, []), false);
console.log('   ✓ User with no properties returns false (warning modal triggers).');

// 2. User with owned properties but 0 improvements
console.log('2. Testing user with owned properties but 0 improvements...');
const unimprovedProps = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, improvements: [], is_listed: false },
  { property_slug: 'baltic_avenue', owner_user_id: USER_ALICE, improvements: null, is_listed: false }
];
assert.equal(canListAnyProperties(USER_ALICE, unimprovedProps), false);
console.log('   ✓ User with only unimproved properties returns false (warning modal triggers).');

// 3. User with owned property having at least 1 improvement
console.log('3. Testing user with owned property having at least 1 improvement...');
const improvedProps = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, improvements: ['windows_doors'], is_listed: false }
];
assert.equal(canListAnyProperties(USER_ALICE, improvedProps), true);
console.log('   ✓ User with improved property returns true (permits navigation to Sell Properties).');

// 4. User with multiple properties where only one has an improvement
console.log('4. Testing user with mixed improved and unimproved properties...');
const mixedProps = [
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, improvements: [], is_listed: false },
  { property_slug: 'baltic_avenue', owner_user_id: USER_ALICE, improvements: ['roof_siding', 'hvac_mechanicals'], is_listed: false }
];
assert.equal(canListAnyProperties(USER_ALICE, mixedProps), true);
console.log('   ✓ User with at least 1 improved property returns true.');

// 5. User with property already actively listed (even if 0 new improvements)
console.log('5. Testing user with actively listed property...');
const listedProps = [
  { property_slug: 'oriental_avenue', owner_user_id: USER_ALICE, improvements: [], is_listed: true }
];
assert.equal(canListAnyProperties(USER_ALICE, listedProps), true);
console.log('   ✓ User with actively listed property returns true (permits managing/delisting).');

// 6. Another player has improvements, but current user does not
console.log('6. Testing user ownership isolation (other players properties ignored)...');
const otherPlayerProps = [
  { property_slug: 'boardwalk', owner_user_id: USER_BOB, improvements: ['windows_doors', 'kitchen_baths'], is_listed: false },
  { property_slug: 'mediterranean_avenue', owner_user_id: USER_ALICE, improvements: [], is_listed: false }
];
assert.equal(canListAnyProperties(USER_ALICE, otherPlayerProps), false);
assert.equal(canListAnyProperties(USER_BOB, otherPlayerProps), true);
console.log('   ✓ Strictly checks current user properties only.');

// 7. Defensive handling of missing or invalid inputs
console.log('7. Testing defensive handling of missing / invalid inputs...');
assert.equal(canListAnyProperties(null, []), false);
assert.equal(canListAnyProperties(USER_ALICE, null), false);
assert.equal(canListAnyProperties(undefined, undefined), false);
console.log('   ✓ Safely handles undefined/null parameters.');

console.log('\n🎉 ALL SELL WARNING UNIT TESTS PASSED PERFECTLY!\n');
