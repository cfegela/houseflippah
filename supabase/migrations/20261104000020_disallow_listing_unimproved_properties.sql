-- Migration: Disallow listing unimproved properties
-- Requires a property to have at least one installed improvement before it can be listed for sale.

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

    IF v_property.is_sold_to_buyer THEN
        RAISE EXCEPTION 'This property has been sold to an outside buyer and cannot be listed';
    END IF;

    IF v_property.owner_user_id IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION 'You do not own this property';
    END IF;

    -- Rule: You cannot buy and list the same property in the same round
    IF v_property.purchased_round = v_room.current_round THEN
        RAISE EXCEPTION 'You cannot list a property in the same round it was purchased';
    END IF;

    -- Rule: You cannot list an unimproved property
    IF v_property.improvements IS NULL OR jsonb_array_length(v_property.improvements) = 0 THEN
        RAISE EXCEPTION 'You cannot list an unimproved property';
    END IF;

    -- Rule: You cannot make improvements and list the same property in the same round
    IF v_property.last_improved_round = v_room.current_round THEN
        RAISE EXCEPTION 'You cannot list a property in the same round improvements were made';
    END IF;

    IF p_list_price IS NULL OR p_list_price <= 0 OR p_list_price > 10000000 THEN
        RAISE EXCEPTION 'List price must be between $1 and $10,000,000';
    END IF;

    IF p_list_price < v_property.mortgage_balance THEN
        RAISE EXCEPTION 'List price must be at least the remaining mortgage balance ($%)', v_property.mortgage_balance;
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

REVOKE EXECUTE ON FUNCTION public.list_property(UUID, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_property(UUID, TEXT, INT) TO authenticated;
