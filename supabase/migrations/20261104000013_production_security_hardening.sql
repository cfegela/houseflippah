-- Migration: Production Security Hardening & Exploit Prevention
-- 1. Drop direct table write RLS policies (all mutations must go through SECURITY DEFINER RPCs)
-- 2. Revoke direct INSERT, UPDATE, DELETE, TRUNCATE table permissions from anon and authenticated roles
-- 3. Revoke PUBLIC and anon execution permissions on RPC functions; grant exclusively to authenticated
-- 4. Enforce upper bound on list_property asking price ($10,000,000 max)
-- 5. Auto-abandon orphaned waiting rooms when a host creates a new room

-- 1. Drop leftover direct write RLS policies
DROP POLICY IF EXISTS "Users can update their own player state" ON public.room_players;
DROP POLICY IF EXISTS "Users can leave room" ON public.room_players;
DROP POLICY IF EXISTS "Host can update room" ON public.rooms;

-- 2. Revoke direct write privileges on tables from client roles
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.rooms FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.room_players FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.catalog_properties FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.game_properties FROM PUBLIC, anon, authenticated;

-- Ensure authenticated users retain SELECT access for reading state & Realtime subscriptions
GRANT SELECT ON public.rooms, public.room_players, public.catalog_properties, public.game_properties TO authenticated;

-- 3. Update create_room to auto-abandon any previous 'waiting' room hosted by the same user
CREATE OR REPLACE FUNCTION public.create_room(p_display_name TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_clean_name TEXT;
    v_room public.rooms%ROWTYPE;
    v_player public.room_players%ROWTYPE;
    v_recent_room_count INT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Abuse prevention: Rate limit (max 5 rooms per 10 minutes per user)
    SELECT COUNT(*) INTO v_recent_room_count
    FROM public.rooms
    WHERE host_id = v_user_id
      AND created_at > (now() - INTERVAL '10 minutes');

    IF v_recent_room_count >= 5 THEN
        RAISE EXCEPTION 'Rate limit exceeded: You can only create up to 5 rooms every 10 minutes.';
    END IF;

    -- Sanitize display name
    v_clean_name := trim(p_display_name);
    IF length(v_clean_name) < 1 OR length(v_clean_name) > 20 THEN
        RAISE EXCEPTION 'Display name must be between 1 and 20 characters.';
    END IF;

    -- Auto-abandon any previous 'waiting' lobbies hosted by this user to prevent orphaned rooms
    DELETE FROM public.room_players
    WHERE room_id IN (
        SELECT id FROM public.rooms WHERE host_id = v_user_id AND status = 'waiting'
    );

    UPDATE public.rooms
    SET status = 'abandoned', updated_at = now()
    WHERE host_id = v_user_id AND status = 'waiting';

    -- Create room
    INSERT INTO public.rooms (host_id, status, max_players)
    VALUES (v_user_id, 'waiting', 4)
    RETURNING * INTO v_room;

    -- Seat the host as Seat 1
    INSERT INTO public.room_players (room_id, user_id, display_name, seat_number, is_host, is_ready)
    VALUES (v_room.id, v_user_id, v_clean_name, 1, true, true)
    RETURNING * INTO v_player;

    RETURN json_build_object(
        'room', row_to_json(v_room),
        'player', row_to_json(v_player)
    );
END;
$$;

-- 4. Update list_property to enforce upper bound on asking price ($1 to $10,000,000)
CREATE OR REPLACE FUNCTION public.list_property(
    p_room_id UUID,
    p_property_slug TEXT,
    p_list_price INT
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_room public.rooms%ROWTYPE;
    v_player public.room_players%ROWTYPE;
    v_property public.game_properties%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Room not found';
    END IF;

    IF v_room.status != 'in_progress' THEN
        RAISE EXCEPTION 'Game is not in progress';
    END IF;

    SELECT * INTO v_player FROM public.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player not found in room';
    END IF;

    IF v_room.current_turn_seat != v_player.seat_number THEN
        RAISE EXCEPTION 'It is not your turn';
    END IF;

    SELECT * INTO v_property FROM public.game_properties
    WHERE room_id = p_room_id AND property_slug = p_property_slug FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Property not found in this game';
    END IF;

    IF v_property.owner_user_id IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION 'You do not own this property';
    END IF;

    -- Rule: You cannot buy and list the same property in the same round
    IF v_property.purchased_round = v_room.current_round THEN
        RAISE EXCEPTION 'You cannot list a property in the same round it was purchased';
    END IF;

    -- Rule: You cannot make improvements and list the same property in the same round
    IF v_property.last_improved_round = v_room.current_round THEN
        RAISE EXCEPTION 'You cannot list a property in the same round improvements were made';
    END IF;

    IF p_list_price IS NULL OR p_list_price <= 0 OR p_list_price > 10000000 THEN
        RAISE EXCEPTION 'List price must be between $1 and $10,000,000';
    END IF;

    UPDATE public.game_properties
    SET is_listed = TRUE,
        list_price = p_list_price,
        listed_round = v_room.current_round,
        last_listed_round = v_room.current_round
    WHERE id = v_property.id
    RETURNING * INTO v_property;

    RETURN json_build_object(
        'success', true,
        'property', row_to_json(v_property)
    );
END;
$$;

-- 5. Lock down RPC execution privileges to authenticated users only
REVOKE EXECUTE ON FUNCTION public.create_room(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.join_room(UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.toggle_ready(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.leave_room(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.start_game(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.buy_property(UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.make_mortgage_payment(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.list_property(UUID, TEXT, INT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.delist_property(UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.make_improvement(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.end_turn(UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_room(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_room(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_ready(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_room(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_game(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buy_property(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.make_mortgage_payment(UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_property(UUID, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delist_property(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.make_improvement(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.end_turn(UUID) TO authenticated;
