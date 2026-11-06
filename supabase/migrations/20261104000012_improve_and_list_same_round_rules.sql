-- Migration: Disallow making improvements and listing in the same round
-- Adds last_improved_round tracking and updates make_improvement and list_property

-- 1. Add columns
ALTER TABLE public.game_properties
ADD COLUMN IF NOT EXISTS last_improved_round INT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS last_listed_round INT DEFAULT NULL;

-- 2. Update list_property to disallow listing if improvements were made in the same round
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

    IF p_list_price <= 0 THEN
        RAISE EXCEPTION 'List price must be greater than 0';
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

GRANT EXECUTE ON FUNCTION public.list_property(UUID, TEXT, INT) TO authenticated;

-- 3. Update make_improvement to disallow improvements on listed properties or in same round listed
CREATE OR REPLACE FUNCTION public.make_improvement(
    p_room_id UUID,
    p_property_slug TEXT,
    p_improvement_key TEXT
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
    v_catalog public.catalog_properties%ROWTYPE;
    v_purchase_price INT;
    v_cost INT;
    v_boost INT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Validate improvement key
    IF p_improvement_key NOT IN (
        'windows_doors',
        'hvac_mechanicals',
        'roof_siding',
        'flooring_painting',
        'kitchen_baths'
    ) THEN
        RAISE EXCEPTION 'Invalid improvement key: %', p_improvement_key;
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
        RAISE EXCEPTION 'Property not found in this game';
    END IF;

    IF v_property.owner_user_id IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION 'You do not own this property';
    END IF;

    -- Rule: Cannot make any improvements in the same round that property was purchased
    IF v_property.purchased_round = v_room.current_round THEN
        RAISE EXCEPTION 'You cannot make improvements in the same round the property was purchased';
    END IF;

    -- Rule: Cannot make improvements if property is listed for sale
    IF v_property.is_listed THEN
        RAISE EXCEPTION 'You cannot make improvements to an actively listed property';
    END IF;

    -- Rule: Cannot list and improve a property in the same round
    IF v_property.last_listed_round = v_room.current_round THEN
        RAISE EXCEPTION 'You cannot make improvements to a property in the same round it was listed';
    END IF;

    -- Rule: Each improvement can only be made once to a property
    IF v_property.improvements ? p_improvement_key THEN
        RAISE EXCEPTION 'This improvement has already been installed on this property';
    END IF;

    -- Get base catalog cost as fallback for purchase_price
    SELECT * INTO v_catalog
    FROM public.catalog_properties
    WHERE slug = p_property_slug;

    v_purchase_price := COALESCE(v_property.purchase_price, v_catalog.cost);

    -- Cost is 10% of purchase price, Boost is 20% of purchase price
    v_cost := (v_purchase_price * 10) / 100;
    v_boost := (v_purchase_price * 20) / 100;

    IF v_player.cash < v_cost THEN
        RAISE EXCEPTION 'Insufficient cash: need $%, but you only have $%', v_cost, v_player.cash;
    END IF;

    -- Deduct cost from player
    UPDATE public.room_players
    SET cash = cash - v_cost,
        last_seen_at = now()
    WHERE id = v_player.id
    RETURNING * INTO v_player;

    -- Add improvement and increase market_value, track last_improved_round
    UPDATE public.game_properties
    SET improvements = improvements || jsonb_build_array(p_improvement_key),
        market_value = COALESCE(market_value, v_purchase_price) + v_boost,
        purchase_price = v_purchase_price,
        last_improved_round = v_room.current_round
    WHERE id = v_property.id
    RETURNING * INTO v_property;

    RETURN json_build_object(
        'success', true,
        'property', row_to_json(v_property),
        'player', row_to_json(v_player),
        'improvement_key', p_improvement_key,
        'cost', v_cost,
        'boost', v_boost,
        'new_market_value', v_property.market_value
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.make_improvement(UUID, TEXT, TEXT) TO authenticated;

-- 4. Update end_turn to reset last_improved_round on foreclosure
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

        -- Advance room round and seat
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
