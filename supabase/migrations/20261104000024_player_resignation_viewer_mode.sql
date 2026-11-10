-- Migration 24: Player Resignation Viewer Mode & Turn Skipping
-- 1. Add is_resigned BOOLEAN NOT NULL DEFAULT false to room_players
-- 2. Update resign_game:
--    - Set is_resigned = true instead of deleting player
--    - Forfeit owned properties to bank with mortgage cleared to 0 and improvements preserved
--    - Host retains is_host and rooms.host_id (no host transfer)
--    - If remaining active count == 1, mark room status = 'completed' (Option A sole survivor)
--    - If remaining active count >= 2 and resigning on turn, advance turn skipping resigned seats
-- 3. Update end_turn to skip resigned players (is_resigned = false) and block resigned players
-- 4. Update buy_property, make_improvement, list_property, delist_property, make_mortgage_payment to block resigned players
-- 5. Update leave_room to handle resigned viewer exit

-- 1. Add is_resigned column
ALTER TABLE public.room_players 
ADD COLUMN IF NOT EXISTS is_resigned BOOLEAN NOT NULL DEFAULT false;

-- Drop any INT overload of make_mortgage_payment if created
DROP FUNCTION IF EXISTS public.make_mortgage_payment(UUID, TEXT, INT);

-- 2. Redefine resign_game
CREATE OR REPLACE FUNCTION public.resign_game(p_room_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_room public.rooms%ROWTYPE;
    v_player public.room_players%ROWTYPE;
    v_remaining_count INT;
    v_winner_user_id UUID;
    v_next_seat INT;
    v_next_round INT;
    v_is_new_round BOOLEAN := false;
    v_temperatures TEXT[] := ARRAY['Ice Cold', 'Chilly', 'Comfy', 'Toasty', 'On Fire'];
    v_random_temp TEXT;

    -- Buyer pool variables
    v_base_odds NUMERIC;
    v_num_improvements INT;
    v_effective_base_odds NUMERIC;
    v_effective_odds NUMERIC;
    v_listed_prop RECORD;
    v_random_buyer TEXT;
    v_mortgage_paid INT;
    v_net_proceeds INT;
    v_foreclosed_prop RECORD;
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

    IF v_player.is_resigned THEN
        RAISE EXCEPTION 'You have already resigned';
    END IF;

    -- Mark player as resigned (do NOT delete)
    UPDATE public.room_players
    SET is_resigned = true
    WHERE room_id = p_room_id AND user_id = v_user_id;

    -- Surrender resigning player's properties back to bank
    -- Trigger trg_maintain_mortgage_balance automatically resets mortgage_balance = 0.
    -- Improvements are preserved.
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
        mortgage_balance = 0,
        purchase_price = cp.cost,
        market_value = cp.cost + (COALESCE(jsonb_array_length(gp.improvements), 0) * ((cp.cost * 20) / 100))
    FROM public.catalog_properties cp
    WHERE gp.property_slug = cp.slug
      AND gp.room_id = p_room_id
      AND gp.owner_user_id = v_user_id;

    -- Count active non-resigned players remaining
    SELECT COUNT(*) INTO v_remaining_count
    FROM public.room_players
    WHERE room_id = p_room_id AND is_resigned = false;

    -- Case A: 0 active remaining players (all resigned or solo player resigned)
    IF v_remaining_count = 0 THEN
        UPDATE public.rooms
        SET status = 'abandoned', updated_at = now()
        WHERE id = p_room_id;

        RETURN json_build_object(
            'success', true,
            'status', 'abandoned',
            'remaining_count', 0
        );
    END IF;

    -- Case B: Exactly 1 active remaining player (sole survivor / winner!)
    IF v_remaining_count = 1 THEN
        SELECT user_id INTO v_winner_user_id
        FROM public.room_players
        WHERE room_id = p_room_id AND is_resigned = false
        LIMIT 1;

        UPDATE public.rooms
        SET status = 'completed', updated_at = now()
        WHERE id = p_room_id
        RETURNING * INTO v_room;

        RETURN json_build_object(
            'success', true,
            'status', 'completed',
            'remaining_count', 1,
            'winner_user_id', v_winner_user_id
        );
    END IF;

    -- Case C: 2 or more active players remain (game continues)
    -- Resigned host retains is_host and host_id (Option B: no host transfer)

    -- Advance turn if it is currently the resigning player's turn
    IF v_room.current_turn_seat = v_player.seat_number THEN
        SELECT seat_number INTO v_next_seat
        FROM public.room_players
        WHERE room_id = p_room_id AND is_resigned = false AND seat_number > v_player.seat_number
        ORDER BY seat_number ASC
        LIMIT 1;

        IF v_next_seat IS NULL THEN
            -- Wrap around to first active non-resigned seat: advances the round!
            SELECT seat_number INTO v_next_seat
            FROM public.room_players
            WHERE room_id = p_room_id AND is_resigned = false
            ORDER BY seat_number ASC
            LIMIT 1;

            v_is_new_round := true;
            v_next_round := v_room.current_round + 1;
        END IF;

        IF v_is_new_round THEN
            -- Automated buyer pool for active remaining players
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
                  AND rp.is_resigned = false
                  AND gp.is_listed = TRUE
                FOR UPDATE OF gp
            LOOP
                v_num_improvements := CASE
                    WHEN jsonb_typeof(v_listed_prop.improvements) = 'array' THEN jsonb_array_length(v_listed_prop.improvements)
                    ELSE 0
                END;

                IF v_num_improvements = 0 THEN
                    v_effective_odds := 0.0;
                ELSE
                    v_effective_base_odds := v_base_odds + (v_num_improvements * 0.05);
                    v_effective_odds := v_effective_base_odds * (1.0 - ((v_listed_prop.list_price - v_listed_prop.market_value)::NUMERIC / v_listed_prop.market_value::NUMERIC));
                    v_effective_odds := GREATEST(0.0, LEAST(1.0, v_effective_odds));
                END IF;

                IF random() < v_effective_odds THEN
                    v_random_buyer := v_buyer_names[1 + floor(random() * array_length(v_buyer_names, 1))::int];
                    v_mortgage_paid := v_listed_prop.mortgage_balance;
                    v_net_proceeds := GREATEST(0, v_listed_prop.list_price - v_mortgage_paid);

                    UPDATE public.room_players
                    SET cash = cash + v_net_proceeds,
                        last_seen_at = now()
                    WHERE room_id = p_room_id AND user_id = v_listed_prop.owner_user_id;

                    INSERT INTO public.property_sales (
                        room_id, property_slug, seller_user_id, seller_name,
                        buyer_user_id, buyer_name, buyer_type, sale_price,
                        mortgage_paid, net_proceeds, round_number
                    ) VALUES (
                        p_room_id, v_listed_prop.property_slug, v_listed_prop.owner_user_id,
                        v_listed_prop.seller_display_name, NULL, v_random_buyer,
                        'automated', v_listed_prop.list_price, v_mortgage_paid,
                        v_net_proceeds, v_room.current_round
                    );

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
                END IF;
            END LOOP;

            -- Foreclosures for active remaining players: record in property_foreclosures
            FOR v_foreclosed_prop IN
                SELECT gp.*, cp.name AS catalog_name, rp.display_name AS owner_display_name
                FROM public.game_properties gp
                JOIN public.catalog_properties cp ON gp.property_slug = cp.slug
                JOIN public.room_players rp ON gp.room_id = rp.room_id AND gp.owner_user_id = rp.user_id
                WHERE gp.room_id = p_room_id
                  AND gp.owner_user_id IS NOT NULL
                  AND rp.is_resigned = false
                  AND gp.last_paid_round < v_room.current_round
                  AND gp.missed_payments >= 1
                FOR UPDATE OF gp
            LOOP
                INSERT INTO public.property_foreclosures (
                    room_id,
                    property_slug,
                    owner_user_id,
                    owner_name,
                    round_number,
                    improvements
                ) VALUES (
                    p_room_id,
                    v_foreclosed_prop.property_slug,
                    v_foreclosed_prop.owner_user_id,
                    v_foreclosed_prop.owner_display_name,
                    v_room.current_round,
                    COALESCE(v_foreclosed_prop.improvements, '[]'::jsonb)
                );
            END LOOP;

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
                mortgage_balance = 0,
                purchase_price = cp.cost,
                market_value = cp.cost + (COALESCE(jsonb_array_length(gp.improvements), 0) * ((cp.cost * 20) / 100))
            FROM public.catalog_properties cp
            WHERE gp.property_slug = cp.slug
              AND gp.room_id = p_room_id
              AND gp.owner_user_id IS NOT NULL
              AND gp.last_paid_round < v_room.current_round
              AND gp.missed_payments >= 1;

            -- Delinquency for active remaining players
            UPDATE public.game_properties
            SET missed_payments = 1
            WHERE room_id = p_room_id
              AND owner_user_id IS NOT NULL
              AND last_paid_round < v_room.current_round
              AND missed_payments = 0;

            v_random_temp := v_temperatures[1 + floor(random() * 5)::int];

            UPDATE public.rooms
            SET current_turn_seat = v_next_seat,
                current_round = v_next_round,
                market_temperature = v_random_temp,
                updated_at = now()
            WHERE id = p_room_id
            RETURNING * INTO v_room;
        ELSE
            UPDATE public.rooms
            SET current_turn_seat = v_next_seat,
                updated_at = now()
            WHERE id = p_room_id
            RETURNING * INTO v_room;
        END IF;
    END IF;

    RETURN json_build_object(
        'success', true,
        'status', 'in_progress',
        'remaining_count', v_remaining_count,
        'current_turn_seat', v_room.current_turn_seat,
        'current_round', v_room.current_round
    );
END;
$$;

-- 3. Redefine end_turn to skip resigned players
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
    v_foreclosed_prop RECORD;
    v_foreclosed_properties JSONB := '[]'::jsonb;
    v_temperatures TEXT[] := ARRAY['Ice Cold', 'Chilly', 'Comfy', 'Toasty', 'On Fire'];
    v_random_temp TEXT;

    -- Automated buyer pool variables
    v_base_odds NUMERIC;
    v_num_improvements INT;
    v_effective_base_odds NUMERIC;
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

    IF v_player.is_resigned THEN
        RAISE EXCEPTION 'You have resigned and cannot take a turn';
    END IF;

    IF v_room.current_turn_seat != v_player.seat_number THEN
        RAISE EXCEPTION 'It is not your turn';
    END IF;

    -- Find the next active non-resigned seat in circular order (skipping resigned and empty seats)
    SELECT seat_number INTO v_next_seat
    FROM public.room_players
    WHERE room_id = p_room_id AND is_resigned = false AND seat_number > v_player.seat_number
    ORDER BY seat_number ASC
    LIMIT 1;

    IF v_next_seat IS NULL THEN
        -- Wrap around to first active non-resigned seat: this advances the round!
        SELECT seat_number INTO v_next_seat
        FROM public.room_players
        WHERE room_id = p_room_id AND is_resigned = false
        ORDER BY seat_number ASC
        LIMIT 1;

        v_is_new_round := true;
        v_next_round := v_room.current_round + 1;
    END IF;

    IF v_is_new_round THEN
        -- AUTOMATED BUYER POOL
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
              AND rp.is_resigned = false
              AND gp.is_listed = TRUE
            FOR UPDATE OF gp
        LOOP
            v_num_improvements := CASE
                WHEN jsonb_typeof(v_listed_prop.improvements) = 'array' THEN jsonb_array_length(v_listed_prop.improvements)
                ELSE 0
            END;

            IF v_num_improvements = 0 THEN
                v_effective_odds := 0.0;
            ELSE
                v_effective_base_odds := v_base_odds + (v_num_improvements * 0.05);
                v_effective_odds := v_effective_base_odds * (1.0 - ((v_listed_prop.list_price - v_listed_prop.market_value)::NUMERIC / v_listed_prop.market_value::NUMERIC));
                v_effective_odds := GREATEST(0.0, LEAST(1.0, v_effective_odds));
            END IF;

            IF random() < v_effective_odds THEN
                v_random_buyer := v_buyer_names[1 + floor(random() * array_length(v_buyer_names, 1))::int];
                v_mortgage_paid := v_listed_prop.mortgage_balance;
                v_net_proceeds := GREATEST(0, v_listed_prop.list_price - v_mortgage_paid);

                UPDATE public.room_players
                SET cash = cash + v_net_proceeds,
                    last_seen_at = now()
                WHERE room_id = p_room_id AND user_id = v_listed_prop.owner_user_id;

                INSERT INTO public.property_sales (
                    room_id, property_slug, seller_user_id, seller_name,
                    buyer_user_id, buyer_name, buyer_type, sale_price,
                    mortgage_paid, net_proceeds, round_number
                ) VALUES (
                    p_room_id, v_listed_prop.property_slug, v_listed_prop.owner_user_id,
                    v_listed_prop.seller_display_name, NULL, v_random_buyer,
                    'automated', v_listed_prop.list_price, v_mortgage_paid,
                    v_net_proceeds, v_room.current_round
                );

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

                v_sold_properties := v_sold_properties || jsonb_build_object(
                    'slug', v_listed_prop.property_slug,
                    'name', v_listed_prop.catalog_name,
                    'buyer', v_random_buyer,
                    'price', v_listed_prop.list_price,
                    'proceeds', v_net_proceeds
                );
            END IF;
        END LOOP;

        -- FORECLOSURES for active non-resigned players
        FOR v_foreclosed_prop IN
            SELECT gp.*, cp.name AS catalog_name, rp.display_name AS owner_display_name
            FROM public.game_properties gp
            JOIN public.catalog_properties cp ON gp.property_slug = cp.slug
            JOIN public.room_players rp ON gp.room_id = rp.room_id AND gp.owner_user_id = rp.user_id
            WHERE gp.room_id = p_room_id
              AND gp.owner_user_id IS NOT NULL
              AND rp.is_resigned = false
              AND gp.last_paid_round < v_room.current_round
              AND gp.missed_payments >= 1
            FOR UPDATE OF gp
        LOOP
            INSERT INTO public.property_foreclosures (
                room_id,
                property_slug,
                owner_user_id,
                owner_name,
                round_number,
                improvements
            ) VALUES (
                p_room_id,
                v_foreclosed_prop.property_slug,
                v_foreclosed_prop.owner_user_id,
                v_foreclosed_prop.owner_display_name,
                v_room.current_round,
                COALESCE(v_foreclosed_prop.improvements, '[]'::jsonb)
            );

            v_foreclosed_count := v_foreclosed_count + 1;
            v_foreclosed_properties := v_foreclosed_properties || jsonb_build_object(
                'property_slug', v_foreclosed_prop.property_slug,
                'property_name', v_foreclosed_prop.catalog_name,
                'owner_user_id', v_foreclosed_prop.owner_user_id,
                'owner_name', v_foreclosed_prop.owner_display_name,
                'round_number', v_room.current_round
            );
        END LOOP;

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
            mortgage_balance = 0,
            purchase_price = cp.cost,
            market_value = cp.cost + (COALESCE(jsonb_array_length(gp.improvements), 0) * ((cp.cost * 20) / 100))
        FROM public.catalog_properties cp
        WHERE gp.property_slug = cp.slug
          AND gp.room_id = p_room_id
          AND gp.owner_user_id IS NOT NULL
          AND gp.last_paid_round < v_room.current_round
          AND gp.missed_payments >= 1;

        -- DELINQUENCY
        UPDATE public.game_properties
        SET missed_payments = 1
        WHERE room_id = p_room_id
          AND owner_user_id IS NOT NULL
          AND last_paid_round < v_room.current_round
          AND missed_payments = 0;

        v_random_temp := v_temperatures[1 + floor(random() * 5)::int];

        UPDATE public.rooms
        SET current_turn_seat = v_next_seat,
            current_round = v_next_round,
            market_temperature = v_random_temp,
            updated_at = now()
        WHERE id = p_room_id
        RETURNING * INTO v_room;
    ELSE
        UPDATE public.rooms
        SET current_turn_seat = v_next_seat,
            updated_at = now()
        WHERE id = p_room_id
        RETURNING * INTO v_room;
    END IF;

    UPDATE public.room_players
    SET last_seen_at = now()
    WHERE room_id = p_room_id AND user_id = v_user_id;

    RETURN json_build_object(
        'success', true,
        'current_turn_seat', v_next_seat,
        'next_seat', v_next_seat,
        'current_round', v_room.current_round,
        'is_new_round', v_is_new_round,
        'foreclosed_count', v_foreclosed_count,
        'foreclosed_properties', v_foreclosed_properties,
        'sold_properties', v_sold_properties,
        'room', row_to_json(v_room)
    );
END;
$$;

-- 4. Guard buy_property against resigned players
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
    v_already_purchased BOOLEAN;
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

    IF v_player.is_resigned THEN
        RAISE EXCEPTION 'You have resigned and cannot purchase properties';
    END IF;

    IF v_room.current_turn_seat != v_player.seat_number THEN
        RAISE EXCEPTION 'It is not your turn';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.game_properties
        WHERE room_id = p_room_id
          AND owner_user_id = v_user_id
          AND purchased_round = v_room.current_round
    ) INTO v_already_purchased;

    IF v_already_purchased THEN
        RAISE EXCEPTION 'You can only purchase 1 property per round';
    END IF;

    SELECT * INTO v_catalog
    FROM public.catalog_properties
    WHERE slug = p_property_slug;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Property catalog entry not found';
    END IF;

    SELECT * INTO v_property
    FROM public.game_properties
    WHERE room_id = p_room_id AND property_slug = p_property_slug
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Property not found in room';
    END IF;

    IF v_property.is_sold_to_buyer THEN
        RAISE EXCEPTION 'This property has already been sold to an outside buyer and is no longer available';
    END IF;

    IF v_property.owner_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'Property is already owned';
    END IF;

    v_down_payment := (v_catalog.cost * 10) / 100;

    IF v_player.cash < v_down_payment THEN
        RAISE EXCEPTION 'Insufficient cash for down payment';
    END IF;

    UPDATE public.room_players
    SET cash = cash - v_down_payment,
        last_seen_at = now()
    WHERE room_id = p_room_id AND user_id = v_user_id
    RETURNING * INTO v_player;

    UPDATE public.game_properties
    SET owner_user_id = v_user_id,
        purchased_at = now(),
        purchased_round = v_room.current_round,
        missed_payments = 0,
        last_paid_round = v_room.current_round,
        purchase_price = v_catalog.cost,
        mortgage_balance = (v_catalog.cost * 90) / 100
    WHERE id = v_property.id
    RETURNING * INTO v_property;

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
        p_property_slug,
        NULL,
        'Bank',
        v_user_id,
        v_player.display_name,
        'player',
        v_catalog.cost,
        0,
        v_catalog.cost,
        v_room.current_round
    );

    RETURN json_build_object(
        'success', true,
        'property', row_to_json(v_property),
        'player', row_to_json(v_player),
        'catalog', row_to_json(v_catalog),
        'down_payment', v_down_payment,
        'property_slug', p_property_slug,
        'cost', v_catalog.cost,
        'remaining_cash', v_player.cash
    );
END;
$$;

-- 5. Guard make_improvement against resigned players
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

    IF v_player.is_resigned THEN
        RAISE EXCEPTION 'You have resigned and cannot make improvements';
    END IF;

    IF v_room.current_turn_seat != v_player.seat_number THEN
        RAISE EXCEPTION 'It is not your turn';
    END IF;

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

    IF v_property.purchased_round = v_room.current_round THEN
        RAISE EXCEPTION 'You cannot make improvements in the same round the property was purchased';
    END IF;

    IF v_property.is_listed THEN
        RAISE EXCEPTION 'You cannot make improvements to an actively listed property';
    END IF;

    IF v_property.last_listed_round = v_room.current_round THEN
        RAISE EXCEPTION 'You cannot make improvements to a property in the same round it was listed';
    END IF;

    IF v_property.improvements ? p_improvement_key THEN
        RAISE EXCEPTION 'This improvement has already been installed on this property';
    END IF;

    SELECT * INTO v_catalog
    FROM public.catalog_properties
    WHERE slug = p_property_slug;

    v_purchase_price := COALESCE(v_property.purchase_price, v_catalog.cost);
    v_cost := (v_purchase_price * 10) / 100;
    v_boost := (v_purchase_price * 20) / 100;

    IF v_player.cash < v_cost THEN
        RAISE EXCEPTION 'Insufficient cash to install improvement';
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
        'value_boost', v_boost,
        'new_market_value', v_property.market_value,
        'remaining_cash', v_player.cash
    );
END;
$$;

-- 6. Guard list_property against resigned players
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
    v_catalog public.catalog_properties%ROWTYPE;
    v_market_value INT;
    v_min_price INT;
    v_max_price INT;
    v_num_improvements INT;
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

    IF v_player.is_resigned THEN
        RAISE EXCEPTION 'You have resigned and cannot list properties';
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

    SELECT * INTO v_catalog
    FROM public.catalog_properties
    WHERE slug = p_property_slug;

    v_market_value := COALESCE(v_property.market_value, v_catalog.cost);
    v_min_price := (v_market_value * 80) / 100;
    v_max_price := (v_market_value * 120) / 100;

    IF p_list_price < v_min_price OR p_list_price > v_max_price THEN
        RAISE EXCEPTION 'List price must be within ±20%% of market value ($% - $%)', v_min_price, v_max_price;
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
        'property', row_to_json(v_property),
        'property_slug', p_property_slug,
        'list_price', p_list_price,
        'market_value', v_market_value
    );
END;
$$;

-- 7. Guard delist_property against resigned players
CREATE OR REPLACE FUNCTION public.delist_property(
    p_room_id UUID,
    p_property_slug TEXT
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

    IF v_player.is_resigned THEN
        RAISE EXCEPTION 'You have resigned and cannot delist properties';
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

    IF NOT v_property.is_listed THEN
        RAISE EXCEPTION 'Property is not listed for sale';
    END IF;

    UPDATE public.game_properties
    SET is_listed = FALSE,
        list_price = NULL,
        listed_round = NULL
    WHERE id = v_property.id
    RETURNING * INTO v_property;

    RETURN json_build_object(
        'success', true,
        'property', row_to_json(v_property),
        'property_slug', p_property_slug
    );
END;
$$;

-- 8. Guard make_mortgage_payment against resigned players (canonical signature: UUID, TEXT, BOOLEAN)
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

    IF v_player.is_resigned THEN
        RAISE EXCEPTION 'You have resigned and cannot make mortgage payments';
    END IF;

    IF v_room.current_turn_seat != v_player.seat_number THEN
        RAISE EXCEPTION 'It is not your turn';
    END IF;

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

    IF v_property.last_paid_round >= v_room.current_round THEN
        RAISE EXCEPTION 'Mortgage is already paid for the current round';
    END IF;

    SELECT * INTO v_catalog
    FROM public.catalog_properties
    WHERE slug = p_property_slug;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Catalog property not found';
    END IF;

    v_base_payment := v_catalog.cost / 40;
    v_is_delinquent := (v_property.missed_payments >= 1);

    IF v_is_delinquent AND p_pay_double THEN
        v_payment_amount := v_base_payment * 2;
    ELSE
        v_payment_amount := v_base_payment;
    END IF;

    IF v_player.cash < v_payment_amount THEN
        RAISE EXCEPTION 'Insufficient cash for mortgage payment. Required: %, Available: %',
            v_payment_amount, v_player.cash;
    END IF;

    UPDATE public.room_players
    SET cash = cash - v_payment_amount,
        last_seen_at = now()
    WHERE id = v_player.id
    RETURNING * INTO v_player;

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

-- 9. Update leave_room for viewer mode
CREATE OR REPLACE FUNCTION public.leave_room(p_room_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_remaining_count INT;
    v_was_host BOOLEAN;
    v_room_status TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT is_host INTO v_was_host
    FROM public.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id;

    SELECT status INTO v_room_status
    FROM public.rooms
    WHERE id = p_room_id;

    IF v_was_host THEN
        -- When host ends the game, update room status to 'abandoned' for all players
        UPDATE public.rooms
        SET status = 'abandoned', updated_at = now()
        WHERE id = p_room_id;

        DELETE FROM public.room_players
        WHERE room_id = p_room_id;
    ELSE
        -- Guest player leaves room
        IF v_room_status = 'in_progress' THEN
            -- Only delegate to resign_game if not already resigned
            IF NOT EXISTS (
                SELECT 1 FROM public.room_players
                WHERE room_id = p_room_id AND user_id = v_user_id AND is_resigned = true
            ) THEN
                PERFORM public.resign_game(p_room_id);
            END IF;
            RETURN json_build_object('success', true, 'was_host', false);
        END IF;

        DELETE FROM public.room_players
        WHERE room_id = p_room_id AND user_id = v_user_id;

        SELECT COUNT(*) INTO v_remaining_count
        FROM public.room_players
        WHERE room_id = p_room_id;

        IF v_remaining_count = 0 THEN
            UPDATE public.rooms
            SET status = 'abandoned', updated_at = now()
            WHERE id = p_room_id;
        END IF;
    END IF;

    RETURN json_build_object('success', true, 'was_host', COALESCE(v_was_host, false));
END;
$$;

-- Security permissions
REVOKE EXECUTE ON FUNCTION public.resign_game(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resign_game(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.make_mortgage_payment(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.make_mortgage_payment(UUID, TEXT, BOOLEAN) TO authenticated;
