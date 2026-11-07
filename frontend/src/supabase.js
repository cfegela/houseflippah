import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Ensures an anonymous authenticated session exists.
 * If none exists, creates one seamlessly.
 */
export async function ensureAnonymousSession() {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) {
    await supabase.auth.signOut().catch(() => {});
  }

  if (session?.user) {
    // Validate that the user actually exists on the backend (e.g. after database resets)
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (!userError && userData?.user) {
      return userData.user;
    }
    // Stale session detected; clear it
    await supabase.auth.signOut().catch(() => {});
  }

  const { data: authData, error: authError } = await supabase.auth.signInAnonymously();
  if (authError) throw authError;

  return authData.user;
}

/**
 * Create a new room with host placed in Seat 1.
 */
export async function createRoom(displayName) {
  await ensureAnonymousSession();
  let { data, error } = await supabase.rpc('create_room', {
    p_display_name: displayName.trim(),
  });

  // Self-heal if the session was invalidated or stale
  if (error && error.message?.includes('foreign key constraint')) {
    await supabase.auth.signOut().catch(() => {});
    await ensureAnonymousSession();
    const retry = await supabase.rpc('create_room', {
      p_display_name: displayName.trim(),
    });
    data = retry.data;
    error = retry.error;
  }

  if (error) throw error;
  return data;
}

/**
 * Concurrency-safe room joining with seat allocation.
 */
export async function joinRoom(roomId, displayName) {
  await ensureAnonymousSession();
  let { data, error } = await supabase.rpc('join_room', {
    p_room_id: roomId,
    p_display_name: displayName.trim(),
  });

  // Self-heal if the session was invalidated or stale
  if (error && error.message?.includes('foreign key constraint')) {
    await supabase.auth.signOut().catch(() => {});
    await ensureAnonymousSession();
    const retry = await supabase.rpc('join_room', {
      p_room_id: roomId,
      p_display_name: displayName.trim(),
    });
    data = retry.data;
    error = retry.error;
  }

  if (error) throw error;
  return data;
}

/**
 * Fetch initial room information and current player list.
 */
export async function fetchRoom(roomId) {
  const [roomRes, playersRes] = await Promise.all([
    supabase.from('rooms').select('*').eq('id', roomId).single(),
    supabase.from('room_players').select('*').eq('room_id', roomId).order('seat_number', { ascending: true })
  ]);

  if (roomRes.error) throw roomRes.error;
  if (playersRes.error) throw playersRes.error;

  return {
    room: roomRes.data,
    players: playersRes.data || [],
  };
}

/**
 * Toggle the ready status for the current user.
 */
export async function toggleReady(roomId) {
  const { data, error } = await supabase.rpc('toggle_ready', {
    p_room_id: roomId,
  });

  if (error) throw error;
  return data;
}

/**
 * Start the game (Host only).
 */
export async function startGame(roomId) {
  const { data, error } = await supabase.rpc('start_game', {
    p_room_id: roomId,
  });

  if (error) throw error;
  return data;
}

/**
 * Buy a property from the bank (10% down financing).
 */
export async function buyProperty(roomId, propertySlug) {
  const { data, error } = await supabase.rpc('buy_property', {
    p_room_id: roomId,
    p_property_slug: propertySlug,
  });

  if (error) throw error;
  return data;
}

/**
 * Make a manual mortgage payment on a property (1/40th value, or 2x if delinquent).
 */
export async function makeMortgagePayment(roomId, propertySlug, payDouble = false) {
  const { data, error } = await supabase.rpc('make_mortgage_payment', {
    p_room_id: roomId,
    p_property_slug: propertySlug,
    p_pay_double: payDouble,
  });

  if (error) throw error;
  return data;
}

/**
 * List a property for sale (cannot list in the same round it was purchased).
 */
export async function listProperty(roomId, propertySlug, listPrice) {
  const { data, error } = await supabase.rpc('list_property', {
    p_room_id: roomId,
    p_property_slug: propertySlug,
    p_list_price: listPrice,
  });

  if (error) throw error;
  return data;
}

/**
 * Remove a property from the sale listings.
 */
export async function delistProperty(roomId, propertySlug) {
  const { data, error } = await supabase.rpc('delist_property', {
    p_room_id: roomId,
    p_property_slug: propertySlug,
  });

  if (error) throw error;
  return data;
}

/**
 * Install an improvement on an owned property.
 */
export async function makeImprovement(roomId, propertySlug, improvementKey) {
  const { data, error } = await supabase.rpc('make_improvement', {
    p_room_id: roomId,
    p_property_slug: propertySlug,
    p_improvement_key: improvementKey,
  });

  if (error) throw error;
  return data;
}

/**
 * End active player turn and advance to the next player.
 */
export async function endTurn(roomId) {
  const { data, error } = await supabase.rpc('end_turn', {
    p_room_id: roomId,
  });

  if (error) throw error;
  return data;
}

/**
 * Fetch full game data (room, players, catalog, room property instances, and property sales).
 */
export async function fetchGameData(roomId) {
  const [roomRes, playersRes, catalogRes, gamePropsRes, salesRes] = await Promise.all([
    supabase.from('rooms').select('*').eq('id', roomId).single(),
    supabase.from('room_players').select('*').eq('room_id', roomId).order('seat_number', { ascending: true }),
    supabase.from('catalog_properties').select('*').order('board_position', { ascending: true }),
    supabase.from('game_properties').select('*').eq('room_id', roomId),
    supabase.from('property_sales').select('*').eq('room_id', roomId).order('round_number', { ascending: false }).order('created_at', { ascending: false }),
  ]);

  if (roomRes.error) throw roomRes.error;
  if (playersRes.error) throw playersRes.error;
  if (catalogRes.error) throw catalogRes.error;
  if (gamePropsRes.error) throw gamePropsRes.error;

  return {
    room: roomRes.data,
    players: playersRes.data || [],
    catalog: catalogRes.data || [],
    gameProperties: gamePropsRes.data || [],
    propertySales: salesRes?.data || [],
  };
}

/**
 * Leave a room.
 */
export async function leaveRoom(roomId) {
  const { data, error } = await supabase.rpc('leave_room', {
    p_room_id: roomId,
  });

  if (error) throw error;
  return data;
}

/**
 * Subscribe to realtime table changes for players, room state, game properties, and sales.
 */
export function subscribeToRoom(roomId, onPlayersChange, onRoomChange, onPropertiesChange, onSalesChange) {
  const channel = supabase.channel(`room:${roomId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'room_players',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        onPlayersChange(payload);
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'rooms',
        filter: `id=eq.${roomId}`,
      },
      (payload) => {
        onRoomChange(payload);
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'game_properties',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        onPropertiesChange(payload);
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'property_sales',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        onSalesChange && onSalesChange(payload);
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
