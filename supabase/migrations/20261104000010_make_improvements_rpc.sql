-- Migration: Add make_improvement RPC for property renovation

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
    v_cost INT;
    v_boost INT;
    v_purchase_price INT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Validate valid improvement key
    IF p_improvement_key NOT IN (
        'windows_doors',
        'hvac_mechanicals',
        'roof_siding',
        'flooring_painting',
        'kitchen_baths'
    ) THEN
        RAISE EXCEPTION 'Invalid improvement key: %', p_improvement_key;
    END IF;

    -- Lock room
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

    -- Lock player
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

    -- Add improvement and increase market_value
    UPDATE public.game_properties
    SET improvements = improvements || jsonb_build_array(p_improvement_key),
        market_value = COALESCE(market_value, v_purchase_price) + v_boost,
        purchase_price = v_purchase_price
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
