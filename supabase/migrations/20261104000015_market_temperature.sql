-- Migration: Add market_temperature to rooms and randomize at round start
-- Options: 'Ice Cold', 'Chilly', 'Comfy', 'Toasty', 'On Fire'

ALTER TABLE public.rooms
ADD COLUMN IF NOT EXISTS market_temperature TEXT NOT NULL DEFAULT 'Comfy';

UPDATE public.rooms
SET market_temperature = 'Comfy'
WHERE market_temperature IS NULL;

-- 1. Update start_game to set initial random market_temperature for Round 1
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
    v_temperatures TEXT[] := ARRAY['Ice Cold', 'Chilly', 'Comfy', 'Toasty', 'On Fire'];
    v_random_temp TEXT;
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

    -- Pick random market temperature for Round 1
    v_random_temp := v_temperatures[1 + floor(random() * 5)::int];

    -- Update room to in_progress with seat 1 starting first, round = 1, and initial temperature
    UPDATE public.rooms
    SET status = 'in_progress',
        current_turn_seat = 1,
        current_round = 1,
        market_temperature = v_random_temp,
        updated_at = now()
    WHERE id = p_room_id
    RETURNING * INTO v_room;

    -- Ensure all players start with $100,000 cash
    UPDATE public.room_players
    SET cash = 100000
    WHERE room_id = p_room_id;

    -- Seed all 28 properties as Bank-owned with clean initial market_value
    INSERT INTO public.game_properties (
        room_id, property_slug, owner_user_id, purchased_at, purchased_round, missed_payments, last_paid_round,
        is_listed, list_price, listed_round, purchase_price, market_value, improvements
    )
    SELECT p_room_id, slug, NULL, NULL, NULL, 0, 0, FALSE, NULL, NULL, NULL, cost, '[]'::jsonb
    FROM public.catalog_properties
    ON CONFLICT (room_id, property_slug) DO UPDATE
    SET owner_user_id = NULL,
        purchased_at = NULL,
        purchased_round = NULL,
        missed_payments = 0,
        last_paid_round = 0,
        is_listed = FALSE,
        list_price = NULL,
        listed_round = NULL,
        purchase_price = NULL,
        market_value = EXCLUDED.market_value,
        improvements = '[]'::jsonb;

    RETURN json_build_object(
        'success', true,
        'room', row_to_json(v_room)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.start_game(UUID) TO authenticated;

-- 2. Update end_turn to re-randomize market_temperature on new round
CREATE OR REPLACE FUNCTION public.end_turn(p_room_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_room public.rooms%ROWTYPE;
    v_player public.room_players%ROWTYPE;
    v_next_seat INT;
    v_next_round INT;
    v_is_new_round BOOLEAN := false;
    v_foreclosed_count INT := 0;
    v_temperatures TEXT[] := ARRAY['Ice Cold', 'Chilly', 'Comfy', 'Toasty', 'On Fire'];
    v_random_temp TEXT;
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

    IF v_room.status != 'in_progress' THEN
        RAISE EXCEPTION 'Game is not in progress';
    END IF;

    SELECT * INTO v_player
    FROM public.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player not found in room';
    END IF;

    IF v_room.current_turn_seat != v_player.seat_number THEN
        RAISE EXCEPTION 'It is not your turn';
    END IF;

    -- Find the next active seat in circular order (skipping empty seats)
    SELECT seat_number INTO v_next_seat
    FROM public.room_players
    WHERE room_id = p_room_id AND seat_number > v_player.seat_number
    ORDER BY seat_number ASC
    LIMIT 1;

    IF v_next_seat IS NULL THEN
        -- Wrap around to first seat: this advances the round!
        SELECT seat_number INTO v_next_seat
        FROM public.room_players
        WHERE room_id = p_room_id
        ORDER BY seat_number ASC
        LIMIT 1;

        v_is_new_round := true;
        v_next_round := v_room.current_round + 1;
    END IF;

    IF v_is_new_round THEN
        -- Foreclose on properties that were already delinquent and not paid
        UPDATE public.game_properties gp
        SET owner_user_id = NULL,
            purchased_at = NULL,
            purchased_round = NULL,
            missed_payments = 0,
            last_paid_round = 0,
            is_listed = FALSE,
            list_price = NULL,
            listed_round = NULL,
            last_listed_round = NULL,
            last_improved_round = NULL,
            purchase_price = cp.cost,
            market_value = cp.cost + (COALESCE(jsonb_array_length(gp.improvements), 0) * ((cp.cost * 20) / 100))
        FROM public.catalog_properties cp
        WHERE gp.property_slug = cp.slug
          AND gp.room_id = p_room_id
          AND gp.owner_user_id IS NOT NULL
          AND gp.last_paid_round < v_room.current_round
          AND gp.missed_payments >= 1;

        GET DIAGNOSTICS v_foreclosed_count = ROW_COUNT;

        -- Mark properties that were not paid as delinquent
        UPDATE public.game_properties
        SET missed_payments = 1
        WHERE room_id = p_room_id
          AND owner_user_id IS NOT NULL
          AND last_paid_round < v_room.current_round
          AND missed_payments = 0;

        -- Pick random market temperature for the new round
        v_random_temp := v_temperatures[1 + floor(random() * 5)::int];

        -- Advance room round, seat, and update market temperature
        UPDATE public.rooms
        SET current_turn_seat = v_next_seat,
            current_round = v_next_round,
            market_temperature = v_random_temp,
            updated_at = now()
        WHERE id = p_room_id
        RETURNING * INTO v_room;
    ELSE
        -- Same round, next seat
        UPDATE public.rooms
        SET current_turn_seat = v_next_seat,
            updated_at = now()
        WHERE id = p_room_id
        RETURNING * INTO v_room;
    END IF;

    RETURN json_build_object(
        'success', true,
        'current_turn_seat', v_next_seat,
        'next_seat', v_next_seat,
        'current_round', v_room.current_round,
        'is_new_round', v_is_new_round,
        'foreclosed_count', v_foreclosed_count,
        'room', row_to_json(v_room)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.end_turn(UUID) TO authenticated;
