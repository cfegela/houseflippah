-- Migration: Allow single or double payment for delinquent mortgages
-- 1. Double payment (2x) brings delinquent mortgage back to good standing (missed_payments = 0)
-- 2. Single payment (1x) staves off foreclosure for the current round while remaining delinquent (missed_payments = 1)

DROP FUNCTION IF EXISTS public.make_mortgage_payment(UUID, TEXT);
DROP FUNCTION IF EXISTS public.make_mortgage_payment(UUID, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION public.make_mortgage_payment(
    p_room_id UUID,
    p_property_slug TEXT,
    p_pay_double BOOLEAN DEFAULT FALSE
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
    v_base_payment INT;
    v_payment_amount INT;
    v_is_delinquent BOOLEAN;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
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

    -- Verify player turn
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

    -- Lock game property
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

    -- Check if mortgage is already paid for current round
    IF v_property.last_paid_round >= v_room.current_round THEN
        RAISE EXCEPTION 'Mortgage is already paid for the current round';
    END IF;

    -- Lookup catalog cost
    SELECT * INTO v_catalog
    FROM public.catalog_properties
    WHERE slug = p_property_slug;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Catalog property not found';
    END IF;

    v_base_payment := v_catalog.cost / 40;
    v_is_delinquent := (v_property.missed_payments >= 1);

    IF v_is_delinquent AND p_pay_double THEN
        -- Double payment (2/40 = 5%) to bring mortgage current
        v_payment_amount := v_base_payment * 2;
    ELSE
        -- Single payment (1/40 = 2.5%)
        v_payment_amount := v_base_payment;
    END IF;

    IF v_player.cash < v_payment_amount THEN
        RAISE EXCEPTION 'Insufficient cash for mortgage payment. Required: %, Available: %',
            v_payment_amount, v_player.cash;
    END IF;

    -- Deduct payment from player cash
    UPDATE public.room_players
    SET cash = cash - v_payment_amount,
        last_seen_at = now()
    WHERE id = v_player.id
    RETURNING * INTO v_player;

    -- Update property:
    -- If delinquent and paid double: missed_payments resets to 0 (current)
    -- If delinquent and paid single: missed_payments remains 1 (still delinquent, but last_paid_round updated prevents foreclosure)
    -- If not delinquent: missed_payments remains 0
    IF v_is_delinquent AND p_pay_double THEN
        UPDATE public.game_properties
        SET last_paid_round = v_room.current_round,
            missed_payments = 0
        WHERE id = v_property.id
        RETURNING * INTO v_property;
    ELSE
        UPDATE public.game_properties
        SET last_paid_round = v_room.current_round
        WHERE id = v_property.id
        RETURNING * INTO v_property;
    END IF;

    RETURN json_build_object(
        'success', true,
        'property', row_to_json(v_property),
        'player', row_to_json(v_player),
        'paid_amount', v_payment_amount,
        'remaining_cash', v_player.cash,
        'last_paid_round', v_room.current_round,
        'missed_payments', v_property.missed_payments,
        'was_double_payment', (v_is_delinquent AND p_pay_double)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.make_mortgage_payment(UUID, TEXT, BOOLEAN) TO authenticated;
