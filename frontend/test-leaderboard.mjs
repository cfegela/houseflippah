import assert from 'node:assert/strict';
import { calculatePlayerEquity, getLeaderboardData } from './src/leaderboard.js';

console.log('🧪 Starting Leaderboard Total Equity & Ranking Unit Tests...\n');

const mockCatalog = [
  { slug: 'mediterranean_avenue', name: 'Mediterranean Avenue', cost: 60000 },
  { slug: 'baltic_avenue', name: 'Baltic Avenue', cost: 60000 },
  { slug: 'boardwalk', name: 'Boardwalk', cost: 400000 }
];

// 1. Initial State: Starting Cash ($100k) with No Properties
console.log('1. Testing initial starting equity ($100,000 cash, 0 properties)...');
const p1 = { user_id: 'u1', display_name: 'Alice', seat_number: 1, cash: 100000 };
assert.equal(calculatePlayerEquity(p1, [], mockCatalog), 100000);
console.log('   ✓ Player with $100k cash and no properties has $100,000 equity.');

// 2. Purchased Property (10% down, 90% mortgage) preserves initial equity
console.log('2. Testing property purchase retains equity ($6k down + $6k property equity = $100k)...');
const p1Bought = { user_id: 'u1', display_name: 'Alice', seat_number: 1, cash: 94000 };
const propsP1 = [
  {
    property_slug: 'mediterranean_avenue',
    owner_user_id: 'u1',
    purchase_price: 60000,
    market_value: 60000,
    mortgage_balance: 54000
  }
];
// Cash: 94,000 + (60,000 - 54,000) = 94,000 + 6,000 = 100,000
assert.equal(calculatePlayerEquity(p1Bought, propsP1, mockCatalog), 100000);
console.log('   ✓ Purchased property preserves exactly $100,000 total equity.');

// 3. Property Improvement increases Market Value & boosts Total Equity
console.log('3. Testing property renovation boosts equity...');
// Player spent $6,000 cash on renovation (cash: 88,000), market value increased by $12,000 (market_value: 72,000)
const p1Improved = { user_id: 'u1', display_name: 'Alice', seat_number: 1, cash: 88000 };
const propsP1Improved = [
  {
    property_slug: 'mediterranean_avenue',
    owner_user_id: 'u1',
    purchase_price: 60000,
    market_value: 72000,
    mortgage_balance: 54000
  }
];
// Cash: 88,000 + (72,000 - 54,000) = 88,000 + 18,000 = 106,000
assert.equal(calculatePlayerEquity(p1Improved, propsP1Improved, mockCatalog), 106000);
console.log('   ✓ Renovation net gain increases total equity from $100k to $106k.');

// 4. Leaderboard Ranking
console.log('4. Testing leaderboard ranking by total equity...');
const p2 = { user_id: 'u2', display_name: 'Bob', seat_number: 2, cash: 100000 };
const p3 = { user_id: 'u3', display_name: 'Charlie', seat_number: 3, cash: 120000 }; // Cash rich (e.g. after a flip)
const p4 = { user_id: 'u4', display_name: 'Dave', seat_number: 4, cash: 90000 };

const allPlayers = [p1Improved, p2, p3, p4];
const allProps = [...propsP1Improved];

const leaderboard = getLeaderboardData(allPlayers, allProps, mockCatalog);

assert.equal(leaderboard.length, 4);
assert.equal(leaderboard[0].displayName, 'Charlie');
assert.equal(leaderboard[0].rank, 1);
assert.equal(leaderboard[0].equity, 120000);

assert.equal(leaderboard[1].displayName, 'Alice');
assert.equal(leaderboard[1].rank, 2);
assert.equal(leaderboard[1].equity, 106000);

assert.equal(leaderboard[2].displayName, 'Bob');
assert.equal(leaderboard[2].rank, 3);
assert.equal(leaderboard[2].equity, 100000);

assert.equal(leaderboard[3].displayName, 'Dave');
assert.equal(leaderboard[3].rank, 4);
assert.equal(leaderboard[3].equity, 90000);

console.log('   ✓ Players correctly ranked #1 Charlie ($120k), #2 Alice ($106k), #3 Bob ($100k), #4 Dave ($90k).');

console.log('\n🎉 ALL LEADERBOARD UNIT TESTS PASSED PERFECTLY!\n');
