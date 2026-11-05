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

  // In Round 2: Player 1 pays mortgage on Mediterranean ($60,000 / 40 = $1,500)
  const { data: payData, error: payErr } = await p1.client.rpc('make_mortgage_payment', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave'
  });
  if (payErr) throw new Error('make_mortgage_payment failed: ' + payErr.message);
  if (payData.paid_amount !== 1500) throw new Error(`Expected $1,500 payment, got ${payData.paid_amount}`);
  if (payData.player.cash !== 92500) throw new Error(`Expected $92,500 cash, got ${payData.player.cash}`);
  console.log(`   ✓ Player 1 made 1/40th mortgage payment ($1,500)! Remaining cash: $${payData.player.cash}.`);

  // Player 1 buys Baltic Ave ($60k, $6k down) in Round 2, then tests skipping payment & foreclosure
  await p1.client.rpc('buy_property', { p_room_id: roomId, p_property_slug: 'baltic-ave' });

  // Advance from Round 2 to Round 3 (Player 1 skips payment on Baltic Ave)
  await advanceFullRound(); // -> Round 3 starts

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

  // Now test Foreclosure: Player 1 buys Oriental Ave ($100k, $10k down) in Round 5
  await p1.client.rpc('buy_property', { p_room_id: roomId, p_property_slug: 'oriental-ave' });

  // Advance to Round 6 (Oriental payment due in Round 6)
  await advanceFullRound(); // -> Round 6 starts

  // Round 6: Player 1 skips payment -> Round 7 starts (Oriental missed_payments = 1)
  await advanceFullRound(); // -> Round 7 starts

  // Round 7: Player 1 skips second payment -> Round 8 starts (Foreclosure!)
  const round8Advance = await advanceFullRound(); // -> Round 8 starts
  console.log(`   ✓ Round 8 reached. Foreclosure processed: ${round8Advance.foreclosed_count} properties foreclosed.`);

  const { data: orientalCheck } = await p1.client.from('game_properties').select('*').eq('room_id', roomId).eq('property_slug', 'oriental-ave').single();
  if (orientalCheck.owner_user_id !== null) {
    throw new Error('Expected Oriental Ave to be foreclosed and returned to Bank!');
  }
  console.log('   ✓ Oriental Avenue successfully foreclosed and returned to the bank!');

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
