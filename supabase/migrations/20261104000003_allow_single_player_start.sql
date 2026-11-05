-- Allow starting a game with just the host (1 or more players)
CREATE OR REPLACE FUNCTION public.start_game(p_room_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_room public.rooms%ROWTYPE;
    v_player_count INT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT * INTO v_room
    FROM public.rooms
    WHERE id = p_room_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Room not found';
    END IF;

    IF v_room.host_id != v_user_id THEN
        RAISE EXCEPTION 'Only the host can start the game';
    END IF;

    IF v_room.status != 'waiting' THEN
        RAISE EXCEPTION 'Game is already %', v_room.status;
    END IF;

    SELECT COUNT(*) INTO v_player_count
    FROM public.room_players
    WHERE room_id = p_room_id;

    IF v_player_count < 1 THEN
        RAISE EXCEPTION 'At least 1 player is required to start the game';
    END IF;

    -- Update room to in_progress with seat 1 starting first
    UPDATE public.rooms
    SET status = 'in_progress',
        current_turn_seat = 1,
        updated_at = now()
    WHERE id = p_room_id
    RETURNING * INTO v_room;

    -- Ensure all players start with $100 cash
    UPDATE public.room_players
    SET cash = 100
    WHERE room_id = p_room_id;

    -- Seed all 28 properties as Bank-owned (owner_user_id = NULL)
    INSERT INTO public.game_properties (room_id, property_slug, owner_user_id)
    SELECT p_room_id, slug, NULL
    FROM public.catalog_properties
    ON CONFLICT (room_id, property_slug) DO UPDATE SET owner_user_id = NULL, purchased_at = NULL;

    RETURN json_build_object(
        'success', true,
        'room', row_to_json(v_room)
    );
END;
$$;
