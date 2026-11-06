-- Migration: Foreclosure preserves property improvements and maintains elevated market value
-- Only purchase_price resets to base catalog price

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
        -- 1. Foreclose on properties that were already delinquent (missed_payments >= 1)
        -- and were NOT brought current during the round that just concluded.
        -- Reset ownership, listings, and reset purchase_price to original catalog cost.
        -- PRESERVE improvements and maintain elevated market_value!
        UPDATE public.game_properties gp
        SET owner_user_id = NULL,
            purchased_at = NULL,
            purchased_round = NULL,
            missed_payments = 0,
            last_paid_round = 0,
            is_listed = FALSE,
            list_price = NULL,
            listed_round = NULL,
            purchase_price = cp.cost,
            market_value = cp.cost + (COALESCE(jsonb_array_length(gp.improvements), 0) * ((cp.cost * 20) / 100))
        FROM public.catalog_properties cp
        WHERE gp.property_slug = cp.slug
          AND gp.room_id = p_room_id
          AND gp.owner_user_id IS NOT NULL
          AND gp.last_paid_round < v_room.current_round
          AND gp.missed_payments >= 1;

        GET DIAGNOSTICS v_foreclosed_count = ROW_COUNT;

        -- 2. Mark properties that were not paid in the round that just concluded as delinquent (missed_payments = 1)
        UPDATE public.game_properties
        SET missed_payments = 1
        WHERE room_id = p_room_id
          AND owner_user_id IS NOT NULL
          AND last_paid_round < v_room.current_round
          AND missed_payments = 0;

        -- 3. Advance room round and seat
        UPDATE public.rooms
        SET current_turn_seat = v_next_seat,
            current_round = v_next_round,
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
        'current_round', v_room.current_round,
        'is_new_round', v_is_new_round,
        'foreclosed_count', v_foreclosed_count,
        'room', row_to_json(v_room)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.end_turn(UUID) TO authenticated;
