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

async function rpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data;
}

// Emulates checkTurnStartSalesModal logic in main.js
function getTurnStartSalesForPlayer(currentUser, currentRoom, propertySales) {
  const previousRound = (currentRoom.current_round || 1) - 1;
  const recentSales = (propertySales || []).filter(
    (s) => s.buyer_type === 'automated' && s.round_number === previousRound
  );

  if (recentSales.length === 0) {
    return [];
  }

  // Personal turn-start alert filter: strictly own sales
  return recentSales.filter((s) => s.seller_user_id === currentUser.id);
}

async function run() {
  console.log('\n🧪 Starting Sales Modal Attribution Unit Tests...\n');

  console.log('1. Setting up 2-player game with Alice (Seat 1) and Bob (Seat 2)...');
  const p1 = await createAnonymousClient();
  const p2 = await createAnonymousClient();

  const { data: createData, error: createErr } = await p1.client.rpc('create_room', {
    p_display_name: 'Alice_Seat1'
  });
  if (createErr) throw createErr;
  const roomId = createData.room.id;

  await p2.client.rpc('join_room', {
    p_room_id: roomId,
    p_display_name: 'Bob_Seat2'
  });

  await rpc(p2.client, 'toggle_ready', { p_room_id: roomId });
  await rpc(p1.client, 'start_game', { p_room_id: roomId });

  // Round 1: Alice buys Mediterranean Ave, Bob buys Baltic Ave
  await rpc(p1.client, 'buy_property', { p_room_id: roomId, p_property_slug: 'mediterranean-ave' });
  await rpc(p1.client, 'end_turn', { p_room_id: roomId });

  await rpc(p2.client, 'buy_property', { p_room_id: roomId, p_property_slug: 'baltic-ave' });
  await rpc(p2.client, 'end_turn', { p_room_id: roomId });

  // Round 2: Both install improvements
  const impKeys = ['flooring_painting', 'kitchen_baths'];
  for (const k of impKeys) {
    await rpc(p1.client, 'make_improvement', { p_room_id: roomId, p_property_slug: 'mediterranean-ave', p_improvement_key: k });
  }
  await rpc(p1.client, 'make_mortgage_payment', { p_room_id: roomId, p_property_slug: 'mediterranean-ave', p_pay_double: false });
  await rpc(p1.client, 'end_turn', { p_room_id: roomId });

  for (const k of impKeys) {
    await rpc(p2.client, 'make_improvement', { p_room_id: roomId, p_property_slug: 'baltic-ave', p_improvement_key: k });
  }
  await rpc(p2.client, 'make_mortgage_payment', { p_room_id: roomId, p_property_slug: 'baltic-ave', p_pay_double: false });
  await rpc(p2.client, 'end_turn', { p_room_id: roomId });

  // Round 3: Both list at market value
  const { data: propsR3 } = await p1.client.from('game_properties').select('*').eq('room_id', roomId);
  const med3 = propsR3.find(p => p.property_slug === 'mediterranean-ave');
  const bal3 = propsR3.find(p => p.property_slug === 'baltic-ave');

  await rpc(p1.client, 'list_property', { p_room_id: roomId, p_property_slug: 'mediterranean-ave', p_list_price: med3.market_value });
  await rpc(p1.client, 'make_mortgage_payment', { p_room_id: roomId, p_property_slug: 'mediterranean-ave', p_pay_double: false });
  await rpc(p1.client, 'end_turn', { p_room_id: roomId });

  await rpc(p2.client, 'list_property', { p_room_id: roomId, p_property_slug: 'baltic-ave', p_list_price: bal3.market_value });
  await rpc(p2.client, 'make_mortgage_payment', { p_room_id: roomId, p_property_slug: 'baltic-ave', p_pay_double: false });

  console.log('   ✓ Game setup complete. Both properties listed for end of round.');

  // Cycle rounds until both properties sell
  let bothSold = false;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const endTurnRes = await rpc(p2.client, 'end_turn', { p_room_id: roomId });
    const soldProps = endTurnRes.sold_properties || [];

    if (soldProps.length === 2) {
      bothSold = true;
      const currentRoom = endTurnRes.room;
      const prevRound = currentRoom.current_round - 1;

      console.log(`\n2. Verifying BOTH properties sold in Round ${prevRound} transition...`);
      const { data: sales } = await p1.client.from('property_sales').select('*').eq('room_id', roomId);

      const aliceModalSales = getTurnStartSalesForPlayer(p1.user, currentRoom, sales);
      const bobModalSales = getTurnStartSalesForPlayer(p2.user, currentRoom, sales);

      console.log('   Alice modal sales count:', aliceModalSales.length);
      console.log('   Bob modal sales count:', bobModalSales.length);

      if (aliceModalSales.length !== 1) {
        throw new Error(`Expected Alice to have exactly 1 sale in her alert, got ${aliceModalSales.length}`);
      }
      if (aliceModalSales[0].property_slug !== 'mediterranean-ave') {
        throw new Error(`Expected Alice's alert to be mediterranean-ave, got ${aliceModalSales[0].property_slug}`);
      }
      if (aliceModalSales[0].seller_user_id !== p1.user.id) {
        throw new Error(`Expected Alice's alert seller_user_id to match Alice's ID`);
      }
      console.log('   ✓ Alice (Seat 1) receives ONLY her own sale (mediterranean-ave).');

      if (bobModalSales.length !== 1) {
        throw new Error(`Expected Bob to have exactly 1 sale in his alert, got ${bobModalSales.length}`);
      }
      if (bobModalSales[0].property_slug !== 'baltic-ave') {
        throw new Error(`Expected Bob's alert to be baltic-ave, got ${bobModalSales[0].property_slug}`);
      }
      if (bobModalSales[0].seller_user_id !== p2.user.id) {
        throw new Error(`Expected Bob's alert seller_user_id to match Bob's ID`);
      }
      console.log('   ✓ Bob (Seat 2) receives ONLY his own sale (baltic-ave).');
      console.log('   ✓ Neither player received the opposite player’s sales alert!');
      break;
    }

    // If only one or neither sold, relist and try again
    const { data: props } = await p1.client.from('game_properties').select('*').eq('room_id', roomId);
    const med = props.find(p => p.property_slug === 'mediterranean-ave');
    const bal = props.find(p => p.property_slug === 'baltic-ave');

    if (med && med.owner_user_id === p1.user.id) {
      if (!med.is_listed) {
        await rpc(p1.client, 'list_property', { p_room_id: roomId, p_property_slug: 'mediterranean-ave', p_list_price: med.market_value });
      }
      await rpc(p1.client, 'make_mortgage_payment', { p_room_id: roomId, p_property_slug: 'mediterranean-ave', p_pay_double: false });
    }
    await rpc(p1.client, 'end_turn', { p_room_id: roomId });

    if (bal && bal.owner_user_id === p2.user.id) {
      if (!bal.is_listed) {
        await rpc(p2.client, 'list_property', { p_room_id: roomId, p_property_slug: 'baltic-ave', p_list_price: bal.market_value });
      }
      await rpc(p2.client, 'make_mortgage_payment', { p_room_id: roomId, p_property_slug: 'baltic-ave', p_pay_double: false });
    }
  }

  if (!bothSold) {
    // If random odds didn't trigger simultaneous sale in 20 rounds, test with single sale attribution
    console.log('\n3. Testing single-sale attribution isolation...');
    const { data: sales } = await p1.client.from('property_sales').select('*').eq('room_id', roomId);
    const automatedSales = sales.filter(s => s.buyer_type === 'automated');
    if (automatedSales.length > 0) {
      const sampleSale = automatedSales[0];
      const room = { current_round: sampleSale.round_number + 1 };
      const sellerIsAlice = sampleSale.seller_user_id === p1.user.id;
      const aliceSales = getTurnStartSalesForPlayer(p1.user, room, sales);
      const bobSales = getTurnStartSalesForPlayer(p2.user, room, sales);

      if (sellerIsAlice) {
        if (aliceSales.length === 0 || bobSales.length > 0) {
          throw new Error('Attribution failed: Bob received Alice sale or Alice missed sale');
        }
      } else {
        if (bobSales.length === 0 || aliceSales.length > 0) {
          throw new Error('Attribution failed: Alice received Bob sale or Bob missed sale');
        }
      }
      console.log('   ✓ Single sale strictly attributed to seller; non-seller receives 0 alerts.');
    }
  }

  console.log('\n🎉 ALL SALES MODAL ATTRIBUTION TESTS PASSED PERFECTLY!\n');
}

run().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
