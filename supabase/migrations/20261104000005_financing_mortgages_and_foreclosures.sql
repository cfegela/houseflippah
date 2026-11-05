-- Migration: Financing, Mortgages, Round Tracking & Foreclosures

-- 1. Add current_round to rooms
ALTER TABLE public.rooms
ADD COLUMN IF NOT EXISTS current_round INT NOT NULL DEFAULT 1;

-- 2. Add mortgage tracking columns to game_properties
ALTER TABLE public.game_properties
ADD COLUMN IF NOT EXISTS purchased_round INT DEFAULT NULL;

ALTER TABLE public.game_properties
ADD COLUMN IF NOT EXISTS missed_payments INT NOT NULL DEFAULT 0;

ALTER TABLE public.game_properties
ADD COLUMN IF NOT EXISTS last_paid_round INT NOT NULL DEFAULT 0;

-- 3. Update start_game: reset current_round to 1 and clean mortgage state
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

    -- Update room to in_progress with seat 1 starting first and round = 1
    UPDATE public.rooms
    SET status = 'in_progress',
        current_turn_seat = 1,
        current_round = 1,
        updated_at = now()
    WHERE id = p_room_id
    RETURNING * INTO v_room;

    -- Ensure all players start with $100,000 cash
    UPDATE public.room_players
    SET cash = 100000
    WHERE room_id = p_room_id;

    -- Seed all 28 properties as Bank-owned with clean mortgage state
    INSERT INTO public.game_properties (
        room_id, property_slug, owner_user_id, purchased_at, purchased_round, missed_payments, last_paid_round
    )
    SELECT p_room_id, slug, NULL, NULL, NULL, 0, 0
    FROM public.catalog_properties
    ON CONFLICT (room_id, property_slug) DO UPDATE
    SET owner_user_id = NULL,
        purchased_at = NULL,
        purchased_round = NULL,
        missed_payments = 0,
        last_paid_round = 0;

    RETURN json_build_object(
        'success', true,
        'room', row_to_json(v_room)
    );
END;
$$;


-- 4. Stored Procedure: Buy Property with 10% Down Financing
CREATE OR REPLACE FUNCTION public.buy_property(p_room_id UUID, p_property_slug TEXT)
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
    v_catalog public.catalog_properties%ROWTYPE;
    v_down_payment INT;
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

    -- Strict turn check
    IF v_room.current_turn_seat != v_player.seat_number THEN
        RAISE EXCEPTION 'It is not your turn';
    END IF;

    -- Lock property
    SELECT * INTO v_property
    FROM public.game_properties
    WHERE room_id = p_room_id AND property_slug = p_property_slug
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Property not found in game';
    END IF;

    IF v_property.owner_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'Property is already owned';
    END IF;

    -- Get catalog price
    SELECT * INTO v_catalog
    FROM public.catalog_properties
    WHERE slug = p_property_slug;

    -- 10% down payment
    v_down_payment := (v_catalog.cost * 10) / 100;

    IF v_player.cash < v_down_payment THEN
        RAISE EXCEPTION 'Insufficient funds: need $%, but you only have $%', v_down_payment, v_player.cash;
    END IF;

    -- Deduct down payment from player cash
    UPDATE public.room_players
    SET cash = cash - v_down_payment,
        last_seen_at = now()
    WHERE id = v_player.id
    RETURNING * INTO v_player;

    -- Transfer ownership to player and set mortgage tracking:
    -- last_paid_round is set to current_round so first payment is due in round R+1
    UPDATE public.game_properties
    SET owner_user_id = v_user_id,
        purchased_at = now(),
        purchased_round = v_room.current_round,
        missed_payments = 0,
        last_paid_round = v_room.current_round
    WHERE id = v_property.id
    RETURNING * INTO v_property;

    RETURN json_build_object(
        'success', true,
        'player', row_to_json(v_player),
        'property', row_to_json(v_property),
        'catalog', row_to_json(v_catalog),
        'down_payment', v_down_payment
    );
END;
$$;


-- 5. Stored Procedure: Make Mortgage Payment (Manual Payment)
CREATE OR REPLACE FUNCTION public.make_mortgage_payment(p_room_id UUID, p_property_slug TEXT)
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
    v_catalog public.catalog_properties%ROWTYPE;
    v_base_payment INT;
    v_required_payment INT;
    v_is_double BOOLEAN := false;
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

    -- Strict turn check
    IF v_room.current_turn_seat != v_player.seat_number THEN
        RAISE EXCEPTION 'It is not your turn';
    END IF;

    -- Lock property
    SELECT * INTO v_property
    FROM public.game_properties
    WHERE room_id = p_room_id AND property_slug = p_property_slug
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Property not found in game';
    END IF;

    IF v_property.owner_user_id IS NULL OR v_property.owner_user_id != v_user_id THEN
        RAISE EXCEPTION 'You do not own this property';
    END IF;

    SELECT * INTO v_catalog
    FROM public.catalog_properties
    WHERE slug = p_property_slug;

    -- Base payment is 1/40th of property cost (simple 10% annual rate)
    v_base_payment := v_catalog.cost / 40;

    -- Check if already paid for the current round
    IF v_property.missed_payments = 0 AND v_property.last_paid_round >= v_room.current_round THEN
        RAISE EXCEPTION 'Mortgage is already paid for the current round';
    END IF;

    -- If delinquent (1 missed payment), require double payment (2x) to bring current
    IF v_property.missed_payments = 1 THEN
        v_required_payment := v_base_payment * 2;
        v_is_double := true;
    ELSE
        v_required_payment := v_base_payment;
        v_is_double := false;
    END IF;

    IF v_player.cash < v_required_payment THEN
        RAISE EXCEPTION 'Insufficient funds: need $%, but you only have $%', v_required_payment, v_player.cash;
    END IF;

    -- Deduct payment from player cash
    UPDATE public.room_players
    SET cash = cash - v_required_payment,
        last_seen_at = now()
    WHERE id = v_player.id
    RETURNING * INTO v_player;

    -- Mark mortgage current and paid for this round
    UPDATE public.game_properties
    SET missed_payments = 0,
        last_paid_round = v_room.current_round
    WHERE id = v_property.id
    RETURNING * INTO v_property;

    RETURN json_build_object(
        'success', true,
        'property', row_to_json(v_property),
        'player', row_to_json(v_player),
        'paid_amount', v_required_payment,
        'was_double_payment', v_is_double
    );
END;
$$;


-- 6. Stored Procedure: End Turn with Round Progression & Foreclosure Processing
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
    v_is_new_round BOOLEAN := false;
    v_next_round INT;
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
    WHERE room_id = p_room_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player not found in room';
    END IF;

    -- Strict turn check: only active player can end their turn
    IF v_room.current_turn_seat != v_player.seat_number THEN
        RAISE EXCEPTION 'It is not your turn to end';
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
        -- and were NOT brought current during the round that just concluded
        UPDATE public.game_properties
        SET owner_user_id = NULL,
            purchased_at = NULL,
            purchased_round = NULL,
            missed_payments = 0,
            last_paid_round = 0
        WHERE room_id = p_room_id
          AND owner_user_id IS NOT NULL
          AND last_paid_round < v_room.current_round
          AND missed_payments >= 1;

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
