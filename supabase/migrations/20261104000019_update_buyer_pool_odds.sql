-- Migration: Update Automated Buyer Pool Base Odds
-- Odds updated to:
-- Ice Cold: 10% (0.10)
-- Chilly:   20% (0.20)
-- Comfy:    30% (0.30)
-- Toasty:   40% (0.40)
-- On Fire:  50% (0.50)

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

    -- Automated buyer pool variables
    v_base_odds NUMERIC;
    v_effective_odds NUMERIC;
    v_listed_prop RECORD;
    v_random_buyer TEXT;
    v_mortgage_paid INT;
    v_net_proceeds INT;
    v_sold_properties JSONB := '[]'::jsonb;
    v_buyer_names TEXT[] := ARRAY[
        'Arthur Sterling', 'Elena Rostova', 'Marcus Thorne', 'Sophia Vance',
        'Montgomery Burns', 'Vivian Westwood', 'Nathaniel Drake', 'Cordelia Chase',
        'Harrison Croft', 'Isabella Sinclair', 'Julian Mercer', 'Beatrice Holloway',
        'Gideon Cross', 'Genevieve Dubois', 'Sebastian Fox', 'Penelope Sterling',
        'Victor Vance', 'Charlotte Dupont', 'Oliver Kensington', 'Eleanor Prescott'
    ];
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
        -- -------------------------------------------------------------
        -- A. AUTOMATED BUYER POOL
        -- Evaluates all actively listed properties using current round's temperature
        -- -------------------------------------------------------------
        CASE v_room.market_temperature
            WHEN 'Ice Cold' THEN v_base_odds := 0.10;
            WHEN 'Chilly'   THEN v_base_odds := 0.20;
            WHEN 'Comfy'    THEN v_base_odds := 0.30;
            WHEN 'Toasty'   THEN v_base_odds := 0.40;
            WHEN 'On Fire'  THEN v_base_odds := 0.50;
            ELSE                 v_base_odds := 0.30;
        END CASE;

        FOR v_listed_prop IN
            SELECT gp.*, cp.name AS catalog_name, rp.display_name AS seller_display_name
            FROM public.game_properties gp
            JOIN public.catalog_properties cp ON gp.property_slug = cp.slug
            JOIN public.room_players rp ON gp.room_id = rp.room_id AND gp.owner_user_id = rp.user_id
            WHERE gp.room_id = p_room_id
              AND gp.owner_user_id IS NOT NULL
              AND gp.is_listed = TRUE
            FOR UPDATE OF gp
        LOOP
            -- Multiplicative odds adjustment relative to base odds:
            -- effective_odds = base_odds * (1 - (list_price - market_value) / market_value)
            -- Clamped between 0.0 (0%) and 1.0 (100%)
            v_effective_odds := v_base_odds * (1.0 - ((v_listed_prop.list_price - v_listed_prop.market_value)::NUMERIC / v_listed_prop.market_value::NUMERIC));
            v_effective_odds := GREATEST(0.0, LEAST(1.0, v_effective_odds));

            IF random() < v_effective_odds THEN
                -- Random automated buyer name
                v_random_buyer := v_buyer_names[1 + floor(random() * array_length(v_buyer_names, 1))::int];

                -- Mortgage payoff & net proceeds
                v_mortgage_paid := v_listed_prop.mortgage_balance;
                v_net_proceeds := GREATEST(0, v_listed_prop.list_price - v_mortgage_paid);

                -- Credit seller's cash
                UPDATE public.room_players
                SET cash = cash + v_net_proceeds,
                    last_seen_at = now()
                WHERE room_id = p_room_id AND user_id = v_listed_prop.owner_user_id;

                -- Record transaction in property_sales
                INSERT INTO public.property_sales (
                    room_id,
                    property_slug,
                    seller_user_id,
                    seller_name,
                    buyer_user_id,
                    buyer_name,
                    buyer_type,
                    sale_price,
                    mortgage_paid,
                    net_proceeds,
                    round_number
                ) VALUES (
                    p_room_id,
                    v_listed_prop.property_slug,
                    v_listed_prop.owner_user_id,
                    v_listed_prop.seller_display_name,
                    NULL,
                    v_random_buyer,
                    'automated',
                    v_listed_prop.list_price,
                    v_mortgage_paid,
                    v_net_proceeds,
                    v_room.current_round
                );

                -- Option B: Property is permanently removed from the game
                UPDATE public.game_properties
                SET owner_user_id = NULL,
                    is_sold_to_buyer = TRUE,
                    is_listed = FALSE,
                    list_price = NULL,
                    listed_round = NULL,
                    last_listed_round = NULL,
                    last_improved_round = NULL,
                    mortgage_balance = 0,
                    missed_payments = 0,
                    last_paid_round = 0
                WHERE id = v_listed_prop.id;

                -- Add to sold_properties return list
                v_sold_properties := v_sold_properties || jsonb_build_object(
                    'property_slug', v_listed_prop.property_slug,
                    'property_name', v_listed_prop.catalog_name,
                    'seller_user_id', v_listed_prop.owner_user_id,
                    'seller_name', v_listed_prop.seller_display_name,
                    'buyer_name', v_random_buyer,
                    'sale_price', v_listed_prop.list_price,
                    'mortgage_paid', v_mortgage_paid,
                    'net_proceeds', v_net_proceeds,
                    'round_number', v_room.current_round
                );
            END IF;
        END LOOP;

        -- -------------------------------------------------------------
        -- B. FORECLOSURES
        -- Foreclose on properties that were already delinquent and not paid
        -- -------------------------------------------------------------
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

        -- -------------------------------------------------------------
        -- C. DELINQUENCY
        -- Mark properties that were not paid as delinquent
        -- -------------------------------------------------------------
        UPDATE public.game_properties
        SET missed_payments = 1
        WHERE room_id = p_room_id
          AND owner_user_id IS NOT NULL
          AND last_paid_round < v_room.current_round
          AND missed_payments = 0;

        -- -------------------------------------------------------------
        -- D. MARKET TEMPERATURE & ROUND ADVANCE
        -- Pick random market temperature for the new round
        -- -------------------------------------------------------------
        v_random_temp := v_temperatures[1 + floor(random() * 5)::int];

        UPDATE public.rooms
        SET current_turn_seat = v_next_seat,
            current_round = v_next_round,
            market_temperature = v_random_temp,
            updated_at = now()
        WHERE id = p_room_id
        RETURNING * INTO v_room;
    ELSE
        -- Same round, advance to next player seat
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
        'sold_properties', v_sold_properties,
        'room', row_to_json(v_room)
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.end_turn(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_turn(UUID) TO authenticated;
