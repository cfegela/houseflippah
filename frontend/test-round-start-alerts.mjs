import { getDelinquentProperties } from './src/delinquency.js';

console.log('\n🧪 Starting Round-Start Alert Modal Tests (All Players Alerted at Round Start)...\n');

// Emulate round-start alert filters in main.js
function checkRoundStartAlerts(userId, currentRoom, gameProperties, propertySales, propertyForeclosures, state) {
  const alertsShown = [];

  // 1. Foreclosure Alert
  if (state.lastAcknowledgedForeclosureRound < currentRoom.current_round) {
    const previousRound = (currentRoom.current_round || 1) - 1;
    const myForeclosures = (propertyForeclosures || []).filter(
      (f) => f.owner_user_id === userId && f.round_number === previousRound
    );
    if (myForeclosures.length > 0) {
      state.lastAcknowledgedForeclosureRound = currentRoom.current_round;
      alertsShown.push({ type: 'foreclosure', items: myForeclosures });
    }
  }

  // 2. Delinquency Warning
  if (state.lastAcknowledgedDelinquencyRound < currentRoom.current_round) {
    const myDelinquentProps = getDelinquentProperties(userId, gameProperties, currentRoom.current_round, propertySales);
    if (myDelinquentProps.length > 0) {
      state.lastAcknowledgedDelinquencyRound = currentRoom.current_round;
      alertsShown.push({ type: 'delinquency', items: myDelinquentProps });
    }
  }

  // 3. Sales Report
  if (state.lastAcknowledgedSalesRound < currentRoom.current_round) {
    const previousRound = (currentRoom.current_round || 1) - 1;
    const recentSales = (propertySales || []).filter(
      (s) => s.buyer_type === 'automated' && s.round_number === previousRound
    );
    const mySales = recentSales.filter((s) => s.seller_user_id === userId);
    if (mySales.length > 0) {
      state.lastAcknowledgedSalesRound = currentRoom.current_round;
      alertsShown.push({ type: 'sales', items: mySales });
    } else if (recentSales.length > 0) {
      // Round had sales but none for this user
      state.lastAcknowledgedSalesRound = currentRoom.current_round;
    }
  }

  return alertsShown;
}

// Test 1: Both Seat 1 and Seat 2 sold properties at the end of Round 1.
console.log('1. Testing both players receiving sales alerts at Round 2 start (even Seat 2 whose turn it is NOT)...');
const round2Room = { current_round: 2, current_turn_seat: 1, status: 'in_progress' };
const sales = [
  { buyer_type: 'automated', round_number: 1, seller_user_id: 'alice-seat-1', property_slug: 'mediterranean-ave', net_proceeds: 30000 },
  { buyer_type: 'automated', round_number: 1, seller_user_id: 'bob-seat-2', property_slug: 'baltic-ave', net_proceeds: 35000 },
];

const aliceState = { lastAcknowledgedForeclosureRound: 0, lastAcknowledgedDelinquencyRound: 0, lastAcknowledgedSalesRound: 0 };
const bobState = { lastAcknowledgedForeclosureRound: 0, lastAcknowledgedDelinquencyRound: 0, lastAcknowledgedSalesRound: 0 };

// Round 2 begins: Seat 1 is active
const aliceAlerts = checkRoundStartAlerts('alice-seat-1', round2Room, [], sales, [], aliceState);
const bobAlerts = checkRoundStartAlerts('bob-seat-2', round2Room, [], sales, [], bobState);

if (aliceAlerts.length !== 1 || aliceAlerts[0].type !== 'sales' || aliceAlerts[0].items[0].property_slug !== 'mediterranean-ave') {
  throw new Error('Alice did not receive her round-start sales alert!');
}
console.log('   ✓ Alice (Seat 1, active turn) receives Mediterranean Ave sales alert at Round 2 start.');

if (bobAlerts.length !== 1 || bobAlerts[0].type !== 'sales' || bobAlerts[0].items[0].property_slug !== 'baltic-ave') {
  throw new Error('Bob did not receive his round-start sales alert!');
}
console.log('   ✓ Bob (Seat 2, NOT active turn) receives Baltic Ave sales alert at Round 2 start.');

// Test 2: Turn advances to Seat 2 within Round 2 -> alerts do NOT re-trigger
console.log('\n2. Testing turn advance to Seat 2 within Round 2 (no duplicate alerts)...');
const round2Turn2Room = { current_round: 2, current_turn_seat: 2, status: 'in_progress' };
const bobTurn2Alerts = checkRoundStartAlerts('bob-seat-2', round2Turn2Room, [], sales, [], bobState);
if (bobTurn2Alerts.length !== 0) {
  throw new Error(`Bob should have 0 alerts on turn 2, got ${bobTurn2Alerts.length}`);
}
console.log('   ✓ Bob receives 0 alerts when his turn begins later in Round 2 (already acknowledged at round start).');

// Test 3: Foreclosure alert at round start for non-active player
console.log('\n3. Testing foreclosure alert at round start for non-active player...');
const round4Room = { current_round: 4, current_turn_seat: 1, status: 'in_progress' };
const foreclosures = [
  { owner_user_id: 'charlie-seat-3', round_number: 3, property_slug: 'oriental-ave' }
];
const charlieState = { lastAcknowledgedForeclosureRound: 0, lastAcknowledgedDelinquencyRound: 0, lastAcknowledgedSalesRound: 0 };
const charlieAlerts = checkRoundStartAlerts('charlie-seat-3', round4Room, [], [], foreclosures, charlieState);

if (charlieAlerts.length !== 1 || charlieAlerts[0].type !== 'foreclosure') {
  throw new Error('Charlie did not receive round-start foreclosure alert!');
}
console.log('   ✓ Charlie (Seat 3, not active turn) receives foreclosure alert at Round 4 start.');

// Test 4: Delinquency alert at round start for non-active player
console.log('\n4. Testing delinquency warning at round start for non-active player...');
const gameProps = [
  { owner_user_id: 'dave-seat-4', property_slug: 'vermont-ave', missed_payments: 1, last_paid_round: 1 }
];
const daveState = { lastAcknowledgedForeclosureRound: 0, lastAcknowledgedDelinquencyRound: 0, lastAcknowledgedSalesRound: 0 };
const daveAlerts = checkRoundStartAlerts('dave-seat-4', round2Room, gameProps, [], [], daveState);

if (daveAlerts.length !== 1 || daveAlerts[0].type !== 'delinquency') {
  throw new Error('Dave did not receive round-start delinquency alert!');
}
console.log('   ✓ Dave (Seat 4, not active turn) receives delinquency alert at Round 2 start.');

// Test 5: Property sold to automated buyer during transition -> receives sales alert, NO delinquency alert
console.log('\n5. Testing property sold during automated buying: receives sales alert, delinquency warning is NOT shown...');
const round3Room = { current_round: 3, current_turn_seat: 1, status: 'in_progress' };
const eveSoldProps = [
  // In DB, property was sold and mortgage cleared
  { owner_user_id: null, property_slug: 'connecticut-ave', missed_payments: 0, last_paid_round: 0, is_sold_to_buyer: true, mortgage_balance: 0 }
];
const eveSales = [
  { buyer_type: 'automated', round_number: 2, seller_user_id: 'eve-seat-5', property_slug: 'connecticut-ave', net_proceeds: 50000 }
];
const eveState = { lastAcknowledgedForeclosureRound: 0, lastAcknowledgedDelinquencyRound: 0, lastAcknowledgedSalesRound: 0 };
const eveAlerts = checkRoundStartAlerts('eve-seat-5', round3Room, eveSoldProps, eveSales, [], eveState);

if (eveAlerts.length !== 1 || eveAlerts[0].type !== 'sales') {
  throw new Error(`Eve should only receive sales alert! Got: ${JSON.stringify(eveAlerts)}`);
}
console.log('   ✓ Eve receives ONLY sales alert (delinquency warning completely suppressed for sold property).');

// Test 6: Even if stale client state still had Eve as owner and missed payments, sales record & cleared mortgage suppress delinquency
console.log('\n6. Testing stale client state with sales record: delinquency warning suppressed...');
const eveStaleProps = [
  { owner_user_id: 'eve-seat-5', property_slug: 'connecticut-ave', missed_payments: 1, last_paid_round: 1, mortgage_balance: 0 }
];
const eveState2 = { lastAcknowledgedForeclosureRound: 0, lastAcknowledgedDelinquencyRound: 0, lastAcknowledgedSalesRound: 0 };
const eveAlerts2 = checkRoundStartAlerts('eve-seat-5', round3Room, eveStaleProps, eveSales, [], eveState2);

if (eveAlerts2.length !== 1 || eveAlerts2[0].type !== 'sales') {
  throw new Error(`Eve should only receive sales alert under stale state! Got: ${JSON.stringify(eveAlerts2)}`);
}
console.log('   ✓ Stale state with cleared mortgage and transition sales record safely suppresses delinquency warning.');

console.log('\n🎉 ALL ROUND-START ALERT MODAL TESTS PASSED PERFECTLY!\n');
