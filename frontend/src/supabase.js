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
  if (sessionError) throw sessionError;

  if (session?.user) {
    return session.user;
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
  const { data, error } = await supabase.rpc('create_room', {
    p_display_name: displayName.trim(),
  });

  if (error) throw error;
  return data;
}

/**
 * Concurrency-safe room joining with seat allocation.
 */
export async function joinRoom(roomId, displayName) {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc('join_room', {
    p_room_id: roomId,
    p_display_name: displayName.trim(),
  });

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
 * Subscribe to realtime table changes for players and room state.
 */
export function subscribeToRoom(roomId, onPlayersChange, onRoomChange) {
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
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
