import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

async function createPlayerClient() {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  return { client, user: data.user };
}

async function runResignTests() {
  console.log('🧪 Starting Resign Game RPC Unit Tests...\n');

  // Test 1: 2-player game. Player 2 has a property and resigns.
  console.log('1. Testing 2-player game where Player 2 resigns with owned property...');
  const p1 = await createPlayerClient();
  const p2 = await createPlayerClient();

  const { data: createData, error: createErr } = await p1.client.rpc('create_room', {
    p_display_name: 'Player One',
  });
  if (createErr) throw createErr;
  const roomId = createData.room.id;

  const { error: joinErr } = await p2.client.rpc('join_room', {
    p_room_id: roomId,
    p_display_name: 'Player Two',
  });
  if (joinErr) throw joinErr;

  // Start game
  const { error: startErr } = await p1.client.rpc('start_game', { p_room_id: roomId });
  if (startErr) throw startErr;

  // Turn is Player One (Seat 1). Let Player One end turn so it is Player Two's turn (Seat 2).
  const { error: endTurn1Err } = await p1.client.rpc('end_turn', { p_room_id: roomId });
  if (endTurn1Err) throw endTurn1Err;

  // Player Two buys Mediterranean Avenue ($60,000)
  const { error: buyErr } = await p2.client.rpc('buy_property', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave',
  });
  if (buyErr) throw buyErr;

  // Verify Player Two owns it and has mortgage
  const { data: propBefore } = await p2.client
    .from('game_properties')
    .select('*')
    .eq('room_id', roomId)
    .eq('property_slug', 'mediterranean-ave')
    .single();

  if (propBefore.owner_user_id !== p2.user.id || propBefore.mortgage_balance <= 0) {
    throw new Error('Property purchase setup failed');
  }

  // Player Two resigns!
  const { data: resignRes, error: resignErr } = await p2.client.rpc('resign_game', {
    p_room_id: roomId,
  });
  if (resignErr) throw resignErr;

  if (resignRes.status !== 'completed' || resignRes.remaining_count !== 1) {
    throw new Error(`Expected completed game with 1 player, got: ${JSON.stringify(resignRes)}`);
  }

  // Verify property surrendered back to bank with mortgage cleared
  const { data: propAfter } = await p1.client
    .from('game_properties')
    .select('*')
    .eq('room_id', roomId)
    .eq('property_slug', 'mediterranean-ave')
    .single();

  if (propAfter.owner_user_id !== null) {
    throw new Error(`Expected owner_user_id NULL, got: ${propAfter.owner_user_id}`);
  }
  if (propAfter.mortgage_balance !== 0) {
    throw new Error(`Expected mortgage_balance 0, got: ${propAfter.mortgage_balance}`);
  }

  // Verify room is completed and Player One is the sole player
  const { data: playersLeft } = await p1.client
    .from('room_players')
    .select('*')
    .eq('room_id', roomId);

  if (playersLeft.length !== 1 || playersLeft[0].user_id !== p1.user.id) {
    throw new Error(`Expected Player One to be sole survivor, got: ${JSON.stringify(playersLeft)}`);
  }

  console.log('   ✓ Player 2 resignation surrendered property, cleared mortgage, and completed game with Player 1 as sole winner.');

  // Test 2: 3-player game. Host (Player A) resigns on their turn.
  console.log('2. Testing 3-player game where Host resigns on their turn (host transfer + turn advance)...');
  const pa = await createPlayerClient();
  const pb = await createPlayerClient();
  const pc = await createPlayerClient();

  const { data: r2Data } = await pa.client.rpc('create_room', { p_display_name: 'Host Alice' });
  const r2Id = r2Data.room.id;

  await pb.client.rpc('join_room', { p_room_id: r2Id, p_display_name: 'Bob' });
  await pc.client.rpc('join_room', { p_room_id: r2Id, p_display_name: 'Charlie' });
  await pa.client.rpc('start_game', { p_room_id: r2Id });

  // Pa is Seat 1, Host. Current turn is Seat 1.
  // Host Alice resigns!
  const { data: paResign, error: paResignErr } = await pa.client.rpc('resign_game', {
    p_room_id: r2Id,
  });
  if (paResignErr) throw paResignErr;

  if (paResign.status !== 'in_progress' || paResign.remaining_count !== 2) {
    throw new Error(`Expected in_progress with 2 players remaining, got: ${JSON.stringify(paResign)}`);
  }
  if (paResign.current_turn_seat !== 2) {
    throw new Error(`Expected turn to advance to Seat 2, got: ${paResign.current_turn_seat}`);
  }

  // Check room host transferred to Bob (lowest seat among remaining players)
  const { data: r2Room } = await pb.client.from('rooms').select('*').eq('id', r2Id).single();
  const { data: r2Bob } = await pb.client
    .from('room_players')
    .select('*')
    .eq('room_id', r2Id)
    .eq('user_id', pb.user.id)
    .single();

  if (r2Room.host_id !== pb.user.id || !r2Bob.is_host) {
    throw new Error(`Expected Bob to become new host, got room host_id=${r2Room.host_id}, bob is_host=${r2Bob.is_host}`);
  }

  console.log('   ✓ Host resignation successfully transferred host to Bob and advanced turn to Seat 2 without ending match.');

  // Test 3: 4-player game. Seat 4 resigns on turn, wrapping turn to Seat 1 and advancing round!
  console.log('3. Testing turn wrap-around to new round when last seat resigns with >= 2 players left...');
  const pA = await createPlayerClient();
  const pB = await createPlayerClient();
  const pC = await createPlayerClient();
  const pD = await createPlayerClient();

  const { data: r3Data } = await pA.client.rpc('create_room', { p_display_name: 'Alice' });
  const r3Id = r3Data.room.id;
  await pB.client.rpc('join_room', { p_room_id: r3Id, p_display_name: 'Bob' });
  await pC.client.rpc('join_room', { p_room_id: r3Id, p_display_name: 'Charlie' });
  await pD.client.rpc('join_room', { p_room_id: r3Id, p_display_name: 'Dave' });
  await pA.client.rpc('start_game', { p_room_id: r3Id });

  // Advance turn through Alice, Bob, Charlie so it is Dave's turn (Seat 4, Round 1)
  await pA.client.rpc('end_turn', { p_room_id: r3Id });
  await pB.client.rpc('end_turn', { p_room_id: r3Id });
  await pC.client.rpc('end_turn', { p_room_id: r3Id });

  // Check room state before Dave resigns
  const { data: r3Before } = await pA.client.from('rooms').select('*').eq('id', r3Id).single();
  if (r3Before.current_turn_seat !== 4 || r3Before.current_round !== 1) {
    throw new Error(`Expected Seat 4, Round 1, got Seat ${r3Before.current_turn_seat}, Round ${r3Before.current_round}`);
  }

  // Dave (Seat 4) resigns on his turn!
  const { data: pDResign, error: pDResignErr } = await pD.client.rpc('resign_game', {
    p_room_id: r3Id,
  });
  if (pDResignErr) throw pDResignErr;

  if (pDResign.status !== 'in_progress' || pDResign.remaining_count !== 3) {
    throw new Error(`Expected in_progress with 3 remaining players, got: ${JSON.stringify(pDResign)}`);
  }
  if (pDResign.current_turn_seat !== 1 || pDResign.current_round !== 2) {
    throw new Error(`Expected turn to wrap to Seat 1 and advance to Round 2, got Seat ${pDResign.current_turn_seat}, Round ${pDResign.current_round}`);
  }

  console.log('   ✓ Resignation on final seat correctly wrapped turn to Seat 1 and advanced match to Round 2.');

  // Test 4: Solo player resigns -> game abandoned
  console.log('4. Testing solo player resignation results in abandoned room...');
  const psolo = await createPlayerClient();
  const { data: soloRoomData } = await psolo.client.rpc('create_room', { p_display_name: 'Solo' });
  const soloRoomId = soloRoomData.room.id;
  await psolo.client.rpc('start_game', { p_room_id: soloRoomId });

  const { data: soloResign } = await psolo.client.rpc('resign_game', { p_room_id: soloRoomId });
  if (soloResign.status !== 'abandoned' || soloResign.remaining_count !== 0) {
    throw new Error(`Expected abandoned status, got: ${JSON.stringify(soloResign)}`);
  }
  console.log('   ✓ Solo player resignation marked room abandoned.');

  console.log('\n🎉 ALL RESIGN GAME RPC UNIT TESTS PASSED PERFECTLY!\n');
}

runResignTests().catch((err) => {
  console.error('❌ Resign game test failed:', err);
  process.exit(1);
});
