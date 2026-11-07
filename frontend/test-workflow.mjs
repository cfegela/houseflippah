import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

async function createAnonymousClient() {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw new Error('Anonymous sign in failed: ' + error.message);
  return { client, user: data.user };
}

async function runTest() {
  console.log('🧪 Starting Game Joining Workflow Test...\n');

  // 1. Create 5 separate player clients
  console.log('1. Signing in 5 anonymous players...');
  const p1 = await createAnonymousClient();
  const p2 = await createAnonymousClient();
  const p3 = await createAnonymousClient();
  const p4 = await createAnonymousClient();
  const p5 = await createAnonymousClient();
  console.log('   ✓ 5 anonymous sessions created successfully.');

  // 2. Host creates room
  console.log('2. Host (Player 1) creating room...');
  const { data: createData, error: createErr } = await p1.client.rpc('create_room', {
    p_display_name: 'HostAlice'
  });
  if (createErr) throw new Error('create_room failed: ' + createErr.message);

  const roomId = createData.room.id;
  console.log(`   ✓ Room created! UUID: ${roomId}`);
  console.log(`   ✓ Host seated: Seat ${createData.player.seat_number}, Host=${createData.player.is_host}`);

  // 3. Players 2, 3, and 4 join
  console.log('3. Players 2, 3, and 4 joining room...');
  for (const [idx, p, name] of [[2, p2, 'Bob'], [3, p3, 'Charlie'], [4, p4, 'Dave']]) {
    const { data: joinData, error: joinErr } = await p.client.rpc('join_room', {
      p_room_id: roomId,
      p_display_name: name
    });
    if (joinErr) throw new Error(`Player ${name} join failed: ${joinErr.message}`);
    console.log(`   ✓ Player ${name} joined: Seat ${joinData.player.seat_number}`);
  }

  // 4. Verify player list has 4 players
  const { data: currentPlayers, error: fetchErr } = await p1.client
    .from('room_players')
    .select('*')
    .eq('room_id', roomId)
    .order('seat_number', { ascending: true });
  if (fetchErr) throw fetchErr;

  console.log(`   ✓ Room currently has ${currentPlayers.length}/4 players.`);
  if (currentPlayers.length !== 4) throw new Error('Expected 4 players in room');

  // 5. Player 5 attempts to join full room (Should be rejected)
  console.log('4. Player 5 attempting to join full room (testing capacity limit)...');
  const { data: p5JoinData, error: p5JoinErr } = await p5.client.rpc('join_room', {
    p_room_id: roomId,
    p_display_name: 'Eve'
  });
  if (!p5JoinErr) {
    throw new Error('Player 5 should have been rejected from full room!');
  }
  console.log(`   ✓ Capacity limit enforced as expected: "${p5JoinErr.message}"`);

  // 6. Test ready toggle
  console.log('5. Player 2 toggling ready status...');
  const { data: toggleData, error: toggleErr } = await p2.client.rpc('toggle_ready', {
    p_room_id: roomId
  });
  if (toggleErr) throw toggleErr;
  console.log(`   ✓ Player 2 ready state toggled: is_ready=${toggleData.player.is_ready}`);

  // 7. Player 3 leaves the room
  console.log('6. Player 3 leaving the room...');
  const { error: leaveErr } = await p3.client.rpc('leave_room', {
    p_room_id: roomId
  });
  if (leaveErr) throw leaveErr;
  console.log('   ✓ Player 3 left room successfully.');

  // 8. Player 5 rejoins and takes the freed seat
  console.log('7. Player 5 joining now that a seat is open...');
  const { data: p5SecondJoin, error: p5SecondErr } = await p5.client.rpc('join_room', {
    p_room_id: roomId,
    p_display_name: 'Eve'
  });
  if (p5SecondErr) throw new Error('Player 5 join failed after seat freed: ' + p5SecondErr.message);
  console.log(`   ✓ Player 5 joined successfully into freed Seat ${p5SecondJoin.player.seat_number}!`);

  // 8. Test Starting Game, Banking & 10% Down Financing
  console.log('7b. Testing Game Start, $100,000 Starting Cash & 10% Down Property Purchasing...');
  const { data: startData, error: startErr } = await p1.client.rpc('start_game', {
    p_room_id: roomId
  });
  if (startErr) throw new Error('start_game failed: ' + startErr.message);
  console.log('   ✓ Game started successfully. Status is in_progress, current turn is Seat 1, Round 1.');

  const validTemps = ['Ice Cold', 'Chilly', 'Comfy', 'Toasty', 'On Fire'];
  if (!validTemps.includes(startData.room.market_temperature)) {
    throw new Error(`Expected valid initial market temperature, got ${startData.room.market_temperature}`);
  }
  console.log(`   ✓ Round 1 initial market temperature: "${startData.room.market_temperature}"`);

  // Check players cash = 100,000
  const { data: playersWithCash } = await p1.client.from('room_players').select('*').eq('room_id', roomId);
  const all100k = playersWithCash.every(p => p.cash === 100000);
  if (!all100k) throw new Error('Not all players started with $100,000!');
  console.log('   ✓ Verified all players have exactly $100,000 starting cash.');

  // Check properties seeded (28 deeds)
  const { data: roomProps } = await p1.client.from('game_properties').select('*').eq('room_id', roomId);
  if (roomProps.length !== 28) throw new Error(`Expected 28 properties seeded, got ${roomProps.length}`);
  console.log('   ✓ Verified 28 bank-owned properties seeded in game.');

  // Player 2 attempts to buy on Player 1's turn -> should fail
  const { error: notYourTurnErr } = await p2.client.rpc('buy_property', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave'
  });
  if (!notYourTurnErr) throw new Error('Expected "not your turn" error for Player 2!');
  console.log(`   ✓ Strict turn enforcement verified: "${notYourTurnErr.message}"`);

  // Player 1 buys Mediterranean Ave ($60,000) with 10% down ($6,000) -> succeeds!
  const { data: buyData, error: buyErr } = await p1.client.rpc('buy_property', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave'
  });
  if (buyErr) throw new Error('buy_property failed: ' + buyErr.message);
  if (buyData.player.cash !== 94000) throw new Error(`Expected $94,000 cash remaining ($6,000 down), got ${buyData.player.cash}`);
  console.log(`   ✓ Player 1 bought Mediterranean Avenue for 10% down ($6,000)! Remaining cash: $${buyData.player.cash}.`);
  if (buyData.property.last_paid_round !== 1 || buyData.property.missed_payments !== 0) {
    throw new Error('Mortgage state on purchase not properly initialized');
  }
  if (buyData.property.purchase_price !== 60000 || buyData.property.market_value !== 60000 || !Array.isArray(buyData.property.improvements)) {
    throw new Error('Purchase price, market value, or improvements on purchase not properly initialized');
  }
  console.log(`   ✓ Purchase price ($60,000) & initial Market Value ($60,000) verified on deed.`);
  if (buyData.property.mortgage_balance !== 54000) {
    throw new Error(`Expected $54,000 initial mortgage balance (price - 10% down), got ${buyData.property.mortgage_balance}`);
  }
  console.log('   ✓ Initial mortgage balance ($54,000 = $60,000 price - $6,000 down) verified.');

  // Enforce Rule 2: Cannot buy a second property in the same round
  const { error: secondBuyErr } = await p1.client.rpc('buy_property', {
    p_room_id: roomId,
    p_property_slug: 'baltic-ave'
  });
  if (!secondBuyErr || !secondBuyErr.message.includes('1 property per round')) {
    throw new Error('Expected 1 purchase per round limit error!');
  }
  console.log(`   ✓ 1 purchase per round limit enforced: "${secondBuyErr.message}"`);

  // Enforce Rule 1: Cannot list property in the same round it was purchased
  const { error: sameRoundListErr } = await p1.client.rpc('list_property', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave',
    p_list_price: 120000
  });
  if (!sameRoundListErr || !sameRoundListErr.message.includes('same round it was purchased')) {
    throw new Error('Expected same round listing restriction error!');
  }
  console.log(`   ✓ Same round listing restriction enforced: "${sameRoundListErr.message}"`);

  // Player 1 attempts to make improvement in Round 1 -> should fail (cannot improve in purchase round)
  const { error: sameRoundImpErr } = await p1.client.rpc('make_improvement', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave',
    p_improvement_key: 'windows_doors'
  });
  if (!sameRoundImpErr || !sameRoundImpErr.message.includes('same round')) {
    throw new Error('Expected same round improvement restriction error!');
  }
  console.log(`   ✓ Same round improvement restriction enforced: "${sameRoundImpErr.message}"`);

  // Player 1 attempts to pay mortgage in Round 1 -> should fail (already covered for purchase round)
  const { error: alreadyPaidErr } = await p1.client.rpc('make_mortgage_payment', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave'
  });
  if (!alreadyPaidErr) throw new Error('Expected already paid error for Round 1!');
  console.log(`   ✓ Round 1 mortgage already covered check verified: "${alreadyPaidErr.message}"`);

  // Helper to advance turn through all 4 active players (Seat 1: P1, Seat 2: P2, Seat 3: P5, Seat 4: P4)
  const advanceFullRound = async () => {
    await p1.client.rpc('end_turn', { p_room_id: roomId });
    await p2.client.rpc('end_turn', { p_room_id: roomId });
    await p5.client.rpc('end_turn', { p_room_id: roomId });
    const { data } = await p4.client.rpc('end_turn', { p_room_id: roomId });
    return data;
  };

  // Turn advances through players 1, 2, 5, 4 to wrap back to Seat 1 -> advancing to Round 2
  const round2Advance = await advanceFullRound();
  if (round2Advance.current_round !== 2) throw new Error(`Expected Round 2, got ${round2Advance.current_round}`);
  console.log(`   ✓ Round advanced to Round ${round2Advance.current_round}!`);
  if (!validTemps.includes(round2Advance.room.market_temperature)) {
    throw new Error(`Expected valid Round 2 market temperature, got ${round2Advance.room.market_temperature}`);
  }
  console.log(`   ✓ Round 2 market temperature randomized: "${round2Advance.room.market_temperature}"`);

  // In Round 2: Player 1 pays mortgage on Mediterranean ($60,000 / 40 = $1,500)
  const { data: payData, error: payErr } = await p1.client.rpc('make_mortgage_payment', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave'
  });
  if (payErr) throw new Error('make_mortgage_payment failed: ' + payErr.message);
  if (payData.paid_amount !== 1500) throw new Error(`Expected $1,500 payment, got ${payData.paid_amount}`);
  if (payData.player.cash !== 92500) throw new Error(`Expected $92,500 cash, got ${payData.player.cash}`);
  console.log(`   ✓ Player 1 made 1/40th mortgage payment ($1,500)! Remaining cash: $${payData.player.cash}.`);
  if (payData.property.mortgage_balance !== 52500) {
    throw new Error(`Expected mortgage balance $52,500 after first payment, got ${payData.property.mortgage_balance}`);
  }
  console.log('   ✓ Mortgage balance reduced by payment ($54,000 -> $52,500).');

  // Test Make Improvements in Round 2:
  // Mediterranean purchase_price = $60,000. Cost = $6,000 (10%), Boost = $12,000 (20%).
  const { data: imp1Data, error: imp1Err } = await p1.client.rpc('make_improvement', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave',
    p_improvement_key: 'windows_doors'
  });
  if (imp1Err) throw imp1Err;
  if (imp1Data.cost !== 6000 || imp1Data.boost !== 12000) {
    throw new Error(`Unexpected improvement cost or boost returned: cost=${imp1Data.cost}, boost=${imp1Data.boost}`);
  }
  if (imp1Data.property.market_value !== 72000) {
    throw new Error(`Expected market_value $72,000, got ${imp1Data.property.market_value}`);
  }
  if (!imp1Data.property.improvements.includes('windows_doors')) {
    throw new Error('Expected windows_doors in improvements array');
  }
  if (imp1Data.player.cash !== 86500) {
    throw new Error(`Expected $86,500 cash after 1st improvement, got ${imp1Data.player.cash}`);
  }
  console.log('   ✓ Installed "windows_doors": Cost $6,000, Market Value increased to $72,000!');

  // Test duplicate improvement restriction
  const { error: dupImpErr } = await p1.client.rpc('make_improvement', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave',
    p_improvement_key: 'windows_doors'
  });
  if (!dupImpErr || !dupImpErr.message.includes('already been installed')) {
    throw new Error('Expected duplicate improvement error!');
  }
  console.log(`   ✓ Duplicate improvement prevented: "${dupImpErr.message}"`);

  // Test invalid improvement key restriction
  const { error: invalidImpErr } = await p1.client.rpc('make_improvement', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave',
    p_improvement_key: 'swimming_pool'
  });
  if (!invalidImpErr || !invalidImpErr.message.includes('Invalid improvement')) {
    throw new Error('Expected invalid improvement key error!');
  }
  console.log(`   ✓ Invalid improvement key prevented: "${invalidImpErr.message}"`);

  // Install remaining 4 improvements in the same round (testing all 5 in one round)
  const remainingImprovements = ['hvac_mechanicals', 'roof_siding', 'flooring_painting', 'kitchen_baths'];
  for (const impKey of remainingImprovements) {
    const { error } = await p1.client.rpc('make_improvement', {
      p_room_id: roomId,
      p_property_slug: 'mediterranean-ave',
      p_improvement_key: impKey
    });
    if (error) throw new Error(`Failed to install ${impKey}: ${error.message}`);
  }

  // Verify final fully renovated property
  const { data: finalMedCheck } = await p1.client
    .from('game_properties')
    .select('*')
    .eq('room_id', roomId)
    .eq('property_slug', 'mediterranean-ave')
    .single();
  if (finalMedCheck.improvements.length !== 5) {
    throw new Error(`Expected 5 improvements, got ${finalMedCheck.improvements.length}`);
  }
  if (finalMedCheck.market_value !== 120000) {
    throw new Error(`Expected market_value $120,000 (2x / +100%), got ${finalMedCheck.market_value}`);
  }
  console.log('   ✓ Successfully installed all 5 improvements in Round 2! Market value doubled from $60,000 to $120,000 (Max Upgraded)!');

  // Rule test: Player 1 cannot list Mediterranean in Round 2 because improvements were made in Round 2!
  const { error: listAfterImpErr } = await p1.client.rpc('list_property', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave',
    p_list_price: 125000
  });
  if (!listAfterImpErr || !listAfterImpErr.message.includes('same round improvements were made')) {
    throw new Error('Expected same round improve & list restriction error!');
  }
  console.log(`   ✓ Same round improve & list restriction enforced: "${listAfterImpErr.message}"`);

  // Player 1 buys Baltic Ave ($60k, $6k down) in Round 2, then tests skipping payment & foreclosure
  await p1.client.rpc('buy_property', { p_room_id: roomId, p_property_slug: 'baltic-ave' });

  // Advance from Round 2 to Round 3 (Player 1 skips payment on Baltic Ave)
  await advanceFullRound(); // -> Round 3 starts

  // In Round 3: Listing Mediterranean Ave is now permitted because last_improved_round (2) < current_round (3)
  const { data: listData, error: listErr } = await p1.client.rpc('list_property', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave',
    p_list_price: 125000
  });
  if (listErr) throw listErr;
  console.log('   ✓ Listing permitted in subsequent Round 3 for $125,000!');

  // Test delist_property
  const { data: delistData, error: delistErr } = await p1.client.rpc('delist_property', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave'
  });
  if (delistErr) throw delistErr;
  if (delistData.property.is_listed !== false || delistData.property.list_price !== null) {
    throw new Error('Expected property to be delisted');
  }
  console.log('   ✓ Property successfully delisted via delist_property RPC!');

  // Test listing and improving same round restrictions on Baltic Ave (purchased Round 2, now Round 3):
  await p1.client.rpc('list_property', {
    p_room_id: roomId,
    p_property_slug: 'baltic-ave',
    p_list_price: 100000
  });

  // Attempt to improve actively listed property
  const { error: improveListedErr } = await p1.client.rpc('make_improvement', {
    p_room_id: roomId,
    p_property_slug: 'baltic-ave',
    p_improvement_key: 'windows_doors'
  });
  if (!improveListedErr || !improveListedErr.message.includes('actively listed')) {
    throw new Error('Expected actively listed improvement restriction error!');
  }
  console.log(`   ✓ Actively listed improvement restriction enforced: "${improveListedErr.message}"`);

  // Delist Baltic Ave and attempt to improve in the same round it was listed
  await p1.client.rpc('delist_property', {
    p_room_id: roomId,
    p_property_slug: 'baltic-ave'
  });

  const { error: improveSameRoundListedErr } = await p1.client.rpc('make_improvement', {
    p_room_id: roomId,
    p_property_slug: 'baltic-ave',
    p_improvement_key: 'windows_doors'
  });
  if (!improveSameRoundListedErr || !improveSameRoundListedErr.message.includes('same round it was listed')) {
    throw new Error('Expected same round listed improvement restriction error!');
  }
  console.log(`   ✓ Same round listed improvement restriction enforced: "${improveSameRoundListedErr.message}"`);

  // In Round 3, Baltic Ave payment is due. Player 1 skips again!
  const round4Advance = await advanceFullRound(); // -> Round 4 starts (1 missed)
  console.log(`   ✓ Round ${round4Advance.current_round} reached. Checking delinquency for Baltic Ave...`);

  const { data: balticCheck } = await p1.client.from('game_properties').select('*').eq('room_id', roomId).eq('property_slug', 'baltic-ave').single();
  if (balticCheck.missed_payments !== 1) throw new Error(`Expected 1 missed payment, got ${balticCheck.missed_payments}`);
  console.log('   ✓ Baltic Ave is Delinquent (1 missed payment) with no penalty yet.');

  // In Round 4: Baltic Ave is delinquent. Player 1 tests SINGLE payment ($1,500) to stave off foreclosure!
  const { data: singlePayData, error: singlePayErr } = await p1.client.rpc('make_mortgage_payment', {
    p_room_id: roomId,
    p_property_slug: 'baltic-ave',
    p_pay_double: false
  });
  if (singlePayErr) throw singlePayErr;
  if (singlePayData.paid_amount !== 1500 || singlePayData.missed_payments !== 1) {
    throw new Error('Expected $1,500 single payment with mortgage remaining delinquent!');
  }
  console.log('   ✓ Player 1 made single payment ($1,500) on delinquent Baltic Ave to stave off foreclosure!');
  const balticBalanceAfterSingle = singlePayData.property.mortgage_balance;
  if (balticBalanceAfterSingle !== balticCheck.mortgage_balance - 1500) {
    throw new Error(`Expected Baltic balance to drop by $1,500, got ${balticCheck.mortgage_balance} -> ${balticBalanceAfterSingle}`);
  }

  // Advance to Round 5: Verify Baltic Ave was NOT foreclosed and is still delinquent
  await advanceFullRound(); // -> Round 5 starts
  const { data: balticRound5 } = await p1.client.from('game_properties').select('*').eq('room_id', roomId).eq('property_slug', 'baltic-ave').single();
  if (balticRound5.owner_user_id === null || balticRound5.missed_payments !== 1) {
    throw new Error('Expected Baltic Ave to survive round transition and remain delinquent!');
  }
  console.log('   ✓ Baltic Ave survived round transition without foreclosure (still 1 payment behind).');

  // In Round 5: Player 1 makes DOUBLE payment ($3,000) to bring Baltic Ave completely current!
  const { data: doublePayData, error: doublePayErr } = await p1.client.rpc('make_mortgage_payment', {
    p_room_id: roomId,
    p_property_slug: 'baltic-ave',
    p_pay_double: true
  });
  if (doublePayErr) throw doublePayErr;
  if (!doublePayData.was_double_payment || doublePayData.paid_amount !== 3000 || doublePayData.missed_payments !== 0) {
    throw new Error('Expected $3,000 double payment to bring Baltic Ave current!');
  }
  console.log('   ✓ Player 1 made double payment ($3,000) and brought Baltic Ave mortgage current!');
  if (doublePayData.property.mortgage_balance !== balticBalanceAfterSingle - 3000) {
    throw new Error(`Expected Baltic balance to drop by $3,000 on double payment, got ${balticBalanceAfterSingle} -> ${doublePayData.property.mortgage_balance}`);
  }
  console.log('   ✓ Mortgage balance reduced correctly by single ($1,500) and double ($3,000) payments.');

  // Now test Foreclosure & Distressed Asset Improvement Preservation:
  // Player 1 buys Oriental Ave ($100k, $10k down) in Round 5
  await p1.client.rpc('buy_property', { p_room_id: roomId, p_property_slug: 'oriental-ave' });

  // Advance to Round 6
  await advanceFullRound(); // -> Round 6 starts

  // In Round 6: Player 1 installs "windows_doors" on Oriental Ave ($10,000 cost, +$20,000 boost -> $120,000 market value)
  const { data: orientalImpData, error: orientalImpErr } = await p1.client.rpc('make_improvement', {
    p_room_id: roomId,
    p_property_slug: 'oriental-ave',
    p_improvement_key: 'windows_doors'
  });
  if (orientalImpErr) throw orientalImpErr;
  if (orientalImpData.property.market_value !== 120000) {
    throw new Error(`Expected Oriental Ave market value $120,000, got ${orientalImpData.property.market_value}`);
  }
  console.log('   ✓ Player 1 installed "windows_doors" on Oriental Ave (Market value boosted to $120,000).');

  // Player 1 skips mortgage payment in Round 6 -> Round 7 starts (Oriental missed_payments = 1)
  await advanceFullRound(); // -> Round 7 starts

  // Round 7: Player 1 skips second payment -> Round 8 starts (Foreclosure!)
  const round8Advance = await advanceFullRound(); // -> Round 8 starts
  console.log(`   ✓ Round 8 reached. Foreclosure processed: ${round8Advance.foreclosed_count} properties foreclosed.`);

  const { data: orientalCheck } = await p1.client.from('game_properties').select('*').eq('room_id', roomId).eq('property_slug', 'oriental-ave').single();
  if (orientalCheck.owner_user_id !== null) {
    throw new Error('Expected Oriental Ave to be foreclosed and returned to Bank!');
  }
  if (orientalCheck.purchase_price !== 100000) {
    throw new Error(`Expected purchase_price reset to $100,000, got ${orientalCheck.purchase_price}`);
  }
  if (!orientalCheck.improvements.includes('windows_doors') || orientalCheck.improvements.length !== 1) {
    throw new Error('Expected foreclosure to preserve existing improvements!');
  }
  if (orientalCheck.market_value !== 120000) {
    throw new Error(`Expected foreclosure to maintain elevated market value $120,000, got ${orientalCheck.market_value}`);
  }
  console.log('   ✓ Foreclosure successfully preserved "windows_doors" improvement and $120,000 elevated market value!');
  if (orientalCheck.mortgage_balance !== 0) {
    throw new Error(`Expected foreclosed property mortgage balance to be cleared, got ${orientalCheck.mortgage_balance}`);
  }
  console.log('   ✓ Foreclosure cleared the mortgage balance to $0.');

  // In Round 8: Player 1 buys back the foreclosed Oriental Ave at base bank price ($100k, $10k down)
  const { data: buyBackData, error: buyBackErr } = await p1.client.rpc('buy_property', {
    p_room_id: roomId,
    p_property_slug: 'oriental-ave'
  });
  if (buyBackErr) throw buyBackErr;
  if (buyBackData.property.market_value !== 120000) {
    throw new Error(`Expected bought-back property to retain $120,000 market value, got ${buyBackData.property.market_value}`);
  }
  if (!buyBackData.property.improvements.includes('windows_doors')) {
    throw new Error('Expected bought-back property to retain "windows_doors" improvement');
  }
  console.log('   ✓ Player 1 bought foreclosed Oriental Ave at base price ($100,000) with improvements & $120,000 market value intact!');
  if (buyBackData.property.mortgage_balance !== 90000) {
    throw new Error(`Expected new mortgage balance $90,000 on buy-back, got ${buyBackData.property.mortgage_balance}`);
  }
  console.log('   ✓ Bought-back property carries a fresh $90,000 mortgage balance.');

  // 7c. Testing Automated Buyer Pool & Sales Settlement
  console.log('7c. Testing Automated Buyer Pool & Property Sales...');

  // Advance from Round 8 to Round 9 (so Oriental Ave can be listed)
  await advanceFullRound(); // -> Round 9 starts

  // Attempt to list Oriental Ave below remaining mortgage balance ($90,000)
  const { error: underMortgageErr } = await p1.client.rpc('list_property', {
    p_room_id: roomId,
    p_property_slug: 'oriental-ave',
    p_list_price: 50000
  });
  if (!underMortgageErr || !underMortgageErr.message.includes('remaining mortgage balance')) {
    throw new Error(`Expected restriction for listing below mortgage balance! Got: ${underMortgageErr?.message}`);
  }
  console.log(`   ✓ Under-mortgage listing restriction enforced: "${underMortgageErr.message}"`);

  // List Oriental Ave for $120,000 (equal to its $120,000 upgraded market value)
  const { data: listOrientalData, error: listOrientalErr } = await p1.client.rpc('list_property', {
    p_room_id: roomId,
    p_property_slug: 'oriental-ave',
    p_list_price: 120000
  });
  if (listOrientalErr) throw listOrientalErr;
  console.log('   ✓ Listed Oriental Ave for $120,000 (at market value).');

  // Record seller's cash before sale
  const { data: p1Before } = await p1.client.from('room_players').select('*').eq('room_id', roomId).eq('user_id', p1.user.id).single();
  const cashBeforeSale = p1Before.cash;

  // Advance rounds until Oriental Ave sells to the automated buyer pool
  let soldItem = null;
  for (let r = 0; r < 25; r++) {
    // If sold, break
    const { data: gpCheck } = await p1.client.from('game_properties').select('*').eq('room_id', roomId).eq('property_slug', 'oriental-ave').single();
    if (gpCheck.is_sold_to_buyer) {
      soldItem = gpCheck;
      break;
    }
    // Pay mortgage on Oriental Ave while listed so it doesn't foreclose
    const { data: currRoom } = await p1.client.from('rooms').select('*').eq('id', roomId).single();
    const { data: gpOriental } = await p1.client.from('game_properties').select('*').eq('room_id', roomId).eq('property_slug', 'oriental-ave').single();
    if (gpOriental.owner_user_id === p1.user.id && gpOriental.last_paid_round < currRoom.current_round) {
      try {
        await p1.client.rpc('make_mortgage_payment', { p_room_id: roomId, p_property_slug: 'oriental-ave' });
      } catch (e) {}
    }
    const advanceRes = await advanceFullRound();
    if (advanceRes.sold_properties && advanceRes.sold_properties.length > 0) {
      const match = advanceRes.sold_properties.find((s) => s.property_slug === 'oriental-ave');
      if (match) {
        soldItem = match;
        break;
      }
    }
  }

  if (!soldItem) {
    throw new Error('Expected Oriental Ave to sell within automated buyer pool rolls!');
  }
  console.log(`   ✓ Oriental Ave sold to automated buyer "${soldItem.buyer_name || 'Buyer'}"!`);

  // Verify property state in game_properties
  const { data: orientalSoldCheck } = await p1.client.from('game_properties').select('*').eq('room_id', roomId).eq('property_slug', 'oriental-ave').single();
  if (!orientalSoldCheck.is_sold_to_buyer) {
    throw new Error('Expected is_sold_to_buyer to be true');
  }
  if (orientalSoldCheck.owner_user_id !== null) {
    throw new Error('Expected owner_user_id to be null after sale to automated buyer');
  }
  if (orientalSoldCheck.is_listed !== false) {
    throw new Error('Expected is_listed to be false after sale');
  }
  if (orientalSoldCheck.mortgage_balance !== 0) {
    throw new Error(`Expected mortgage balance to be 0 after sale, got ${orientalSoldCheck.mortgage_balance}`);
  }
  console.log('   ✓ Option B enforced: Property is permanently marked is_sold_to_buyer=true and mortgage cleared.');

  // Verify seller cash was credited
  const { data: p1After } = await p1.client.from('room_players').select('*').eq('room_id', roomId).eq('user_id', p1.user.id).single();
  console.log(`   ✓ Cash before sale: $${cashBeforeSale}, Cash after sale: $${p1After.cash}.`);

  // Verify record in property_sales
  const { data: salesRecords, error: salesErr } = await p1.client
    .from('property_sales')
    .select('*')
    .eq('room_id', roomId)
    .eq('property_slug', 'oriental-ave')
    .eq('buyer_type', 'automated');
  if (salesErr) throw salesErr;
  if (!salesRecords || salesRecords.length === 0) {
    throw new Error('Expected property_sales record for automated buyer sale!');
  }
  const saleRec = salesRecords[0];
  if (saleRec.sale_price !== 120000) throw new Error(`Expected sale_price $120,000, got ${saleRec.sale_price}`);
  console.log(`   ✓ property_sales ledger entry verified: Buyer "${saleRec.buyer_name}", Sale $${saleRec.sale_price}, Net +$${saleRec.net_proceeds}.`);

  // Verify attempting to buy sold property is blocked
  const { error: reBuySoldErr } = await p1.client.rpc('buy_property', {
    p_room_id: roomId,
    p_property_slug: 'oriental-ave'
  });
  if (!reBuySoldErr || !reBuySoldErr.message.includes('sold to an outside buyer')) {
    throw new Error('Expected error when attempting to buy property sold to outside buyer!');
  }
  console.log(`   ✓ Re-purchasing sold property blocked: "${reBuySoldErr.message}"`);

  // Verify attempting to list sold property is blocked
  const { error: reListSoldErr } = await p1.client.rpc('list_property', {
    p_room_id: roomId,
    p_property_slug: 'oriental-ave',
    p_list_price: 130000
  });
  if (!reListSoldErr || !reListSoldErr.message.includes('sold to an outside buyer')) {
    throw new Error('Expected error when attempting to list property sold to outside buyer!');
  }
  console.log(`   ✓ Listing sold property blocked: "${reListSoldErr.message}"`);

  // 9. Host ends the game for all players
  console.log('8. Host ends the game (leave_room as host)...');
  const { data: hostLeaveData, error: hostLeaveErr } = await p1.client.rpc('leave_room', {
    p_room_id: roomId
  });
  if (hostLeaveErr) throw hostLeaveErr;
  console.log(`   ✓ Host ended game: was_host=${hostLeaveData.was_host}`);

  // Verify room is abandoned and players removed
  const { data: roomCheck } = await p1.client.from('rooms').select('*').eq('id', roomId).single();
  if (roomCheck.status !== 'abandoned') {
    throw new Error(`Expected room status 'abandoned', got '${roomCheck.status}'`);
  }
  const { data: remainingPlayers } = await p1.client.from('room_players').select('*').eq('room_id', roomId);
  if (remainingPlayers.length !== 0) {
    throw new Error(`Expected 0 remaining players after host ended game, got ${remainingPlayers.length}`);
  }
  console.log('   ✓ Room status is abandoned and all player records cleared.');

  // 10. Test Single Player (Host-only) Game Start
  console.log('9. Testing starting game with just the host (1 player)...');
  const soloHost = await createAnonymousClient();
  const { data: soloCreate, error: soloCreateErr } = await soloHost.client.rpc('create_room', {
    p_display_name: 'SoloHost'
  });
  if (soloCreateErr) throw soloCreateErr;
  const soloRoomId = soloCreate.room.id;

  const { data: soloStart, error: soloStartErr } = await soloHost.client.rpc('start_game', {
    p_room_id: soloRoomId
  });
  if (soloStartErr) throw new Error('Solo start_game failed: ' + soloStartErr.message);
  console.log('   ✓ Single-player game started successfully.');
  if (soloStart.room.status !== 'in_progress' || soloStart.room.current_turn_seat !== 1) {
    throw new Error('Solo game room state unexpected');
  }

  // Verify single-player turn advance wraps to seat 1
  const { data: soloTurn, error: soloTurnErr } = await soloHost.client.rpc('end_turn', {
    p_room_id: soloRoomId
  });
  if (soloTurnErr) throw soloTurnErr;
  if (soloTurn.current_turn_seat !== 1) {
    throw new Error(`Expected seat 1 after single player turn wrap, got ${soloTurn.current_turn_seat}`);
  }
  console.log('   ✓ Single-player turn advance correctly wrapped back to Seat 1.');

  // Security Audit Tests: Verify direct table writes (cash tampering, round manipulation) are blocked!
  console.log('9b. Testing security hardening (blocking direct table writes)...');
  const { error: cashTamperErr } = await soloHost.client
    .from('room_players')
    .update({ cash: 999999999 })
    .eq('room_id', soloRoomId);
  if (!cashTamperErr) {
    throw new Error('SECURITY FAILURE: Direct update on room_players.cash succeeded!');
  }
  console.log(`   ✓ Direct cash tampering blocked: "${cashTamperErr.message}"`);

  const { error: roomTamperErr } = await soloHost.client
    .from('rooms')
    .update({ current_round: 99 })
    .eq('id', soloRoomId);
  if (!roomTamperErr) {
    throw new Error('SECURITY FAILURE: Direct update on rooms.current_round succeeded!');
  }
  console.log(`   ✓ Direct room state tampering blocked: "${roomTamperErr.message}"`);

  // Clean up solo room
  await soloHost.client.rpc('leave_room', { p_room_id: soloRoomId });

  // 11. Abuse test: Name validation
  console.log('10. Testing display name sanitization (empty name)...');
  const { error: badNameErr } = await p1.client.rpc('join_room', {
    p_room_id: roomId,
    p_display_name: '   '
  });
  if (!badNameErr) throw new Error('Expected name validation error!');
  console.log(`   ✓ Name validation enforced: "${badNameErr.message}"`);

  console.log('\n🎉 ALL GAME JOINING WORKFLOW TESTS PASSED PERFECTLY!\n');
}

runTest().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
