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

  // 9. Abuse test: Name validation
  console.log('8. Testing display name sanitization (empty name)...');
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
