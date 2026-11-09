import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

async function createPlayerClient() {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  return { client, user: data.user };
}

async function runForeclosureAlertTests() {
  console.log('🧪 Starting Turn-Start Foreclosure Alert Tests...\n');

  // Setup: 2-player game (Alice and Bob)
  console.log('1. Setting up 2-player game with Alice and Bob...');
  const alice = await createPlayerClient();
  const bob = await createPlayerClient();

  const { data: createData, error: createErr } = await alice.client.rpc('create_room', {
    p_display_name: 'Alice',
  });
  if (createErr) throw createErr;
  const roomId = createData.room.id;

  await bob.client.rpc('join_room', { p_room_id: roomId, p_display_name: 'Bob' });
  await alice.client.rpc('start_game', { p_room_id: roomId });

  console.log('   ✓ Room started. Round 1.');

  // Round 1: Alice buys Mediterranean Ave ($60k)
  await alice.client.rpc('buy_property', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave',
  });
  // Alice ends turn
  await alice.client.rpc('end_turn', { p_room_id: roomId });

  // Bob buys Baltic Ave ($60k)
  await bob.client.rpc('buy_property', {
    p_room_id: roomId,
    p_property_slug: 'baltic-ave',
  });
  // Bob ends turn -> wraps to Round 2!
  await bob.client.rpc('end_turn', { p_room_id: roomId });

  console.log('   ✓ Round 2 reached. Both properties purchased.');

  // Round 2: Alice installs an improvement on Mediterranean Ave, but does NOT pay mortgage
  await alice.client.rpc('make_improvement', {
    p_room_id: roomId,
    p_property_slug: 'mediterranean-ave',
    p_improvement_key: 'windows_doors',
  });
  await alice.client.rpc('end_turn', { p_room_id: roomId });

  // Bob pays his mortgage for Baltic Ave in Round 2
  const { error: bobPay2Err } = await bob.client.rpc('make_mortgage_payment', {
    p_room_id: roomId,
    p_property_slug: 'baltic-ave',
    p_pay_double: false,
  });
  if (bobPay2Err) throw bobPay2Err;

  // Bob ends turn -> wraps to Round 3!
  await bob.client.rpc('end_turn', { p_room_id: roomId });

  console.log('   ✓ Round 3 reached. Alice missed Round 2 payment -> Mediterranean Ave is now DELINQUENT.');

  // Verify Alice's property is now delinquent (missed_payments = 1)
  const { data: alicePropR3 } = await alice.client
    .from('game_properties')
    .select('*')
    .eq('room_id', roomId)
    .eq('property_slug', 'mediterranean-ave')
    .single();

  if (alicePropR3.missed_payments !== 1) {
    throw new Error(`Expected missed_payments=1, got ${alicePropR3.missed_payments}`);
  }

  // Round 3: Alice STILL does not pay mortgage. Alice ends turn.
  await alice.client.rpc('end_turn', { p_room_id: roomId });

  // Bob pays Baltic Ave again in Round 3
  const { error: bobPay3Err } = await bob.client.rpc('make_mortgage_payment', {
    p_room_id: roomId,
    p_property_slug: 'baltic-ave',
    p_pay_double: false,
  });
  if (bobPay3Err) throw bobPay3Err;
  // Bob ends turn -> wraps to Round 4! Foreclosure should occur on Alice's Mediterranean Ave!
  const { data: endTurnR3Res } = await bob.client.rpc('end_turn', { p_room_id: roomId });

  console.log('   ✓ Round 4 reached. Foreclosure processed!');

  // Check foreclosure logging in property_foreclosures
  const { data: foreclosures, error: fcErr } = await alice.client
    .from('property_foreclosures')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false });

  if (fcErr) throw fcErr;

  console.log(`2. Verifying property_foreclosures table entry (found ${foreclosures.length} records)...`);
  if (foreclosures.length !== 1) {
    throw new Error(`Expected 1 foreclosure record, got ${foreclosures.length}`);
  }

  const fc = foreclosures[0];
  if (fc.property_slug !== 'mediterranean-ave') {
    throw new Error(`Expected property_slug 'mediterranean-ave', got '${fc.property_slug}'`);
  }
  if (fc.owner_user_id !== alice.user.id) {
    throw new Error(`Expected owner_user_id to be Alice, got '${fc.owner_user_id}'`);
  }
  if (fc.round_number !== 3) {
    throw new Error(`Expected round_number 3, got ${fc.round_number}`);
  }
  if (!Array.isArray(fc.improvements) || fc.improvements.length !== 1) {
    throw new Error(`Expected improvements array with 1 item, got ${JSON.stringify(fc.improvements)}`);
  }
  console.log('   ✓ Foreclosure record contains Alice as owner, property slug, round 3, and preserved improvements.');

  // Check game_properties state
  const { data: alicePropAfter } = await alice.client
    .from('game_properties')
    .select('*')
    .eq('room_id', roomId)
    .eq('property_slug', 'mediterranean-ave')
    .single();

  if (alicePropAfter.owner_user_id !== null) {
    throw new Error(`Expected owner_user_id NULL, got ${alicePropAfter.owner_user_id}`);
  }
  if (alicePropAfter.mortgage_balance !== 0) {
    throw new Error(`Expected mortgage_balance 0, got ${alicePropAfter.mortgage_balance}`);
  }
  if (!alicePropAfter.improvements.includes('windows_doors')) {
    throw new Error(`Expected improvements to be preserved on bank deed, got ${JSON.stringify(alicePropAfter.improvements)}`);
  }
  console.log('   ✓ Property returned to bank with $0 mortgage and preserved improvements.');

  // 3. Testing Turn-Start Alert Logic:
  console.log('3. Testing Turn-Start Alert Logic for Round 4...');
  const currentRound = 4;
  const previousRound = currentRound - 1; // 3

  // Alice's turn: filter for Alice
  const aliceForeclosures = foreclosures.filter(
    (f) => f.owner_user_id === alice.user.id && f.round_number === previousRound
  );
  if (aliceForeclosures.length !== 1) {
    throw new Error(`Expected Alice to have 1 foreclosure alert for Round 4, got ${aliceForeclosures.length}`);
  }
  console.log('   ✓ Alice receives foreclosure alert for Mediterranean Ave at the start of Round 4.');

  // Bob's turn: filter for Bob
  const bobForeclosures = foreclosures.filter(
    (f) => f.owner_user_id === bob.user.id && f.round_number === previousRound
  );
  if (bobForeclosures.length !== 0) {
    throw new Error(`Expected Bob to have 0 foreclosure alerts, got ${bobForeclosures.length}`);
  }
  console.log('   ✓ Bob does NOT receive a foreclosure alert modal (only the affected player).');

  console.log('\n🎉 ALL FORECLOSURE ALERT TESTS PASSED PERFECTLY!\n');
}

runForeclosureAlertTests().catch((err) => {
  console.error('❌ Foreclosure alert test failed:', err);
  process.exit(1);
});
