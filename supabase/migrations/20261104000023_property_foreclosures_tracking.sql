-- Migration 23: Track Property Foreclosures & Log
-- 1. Create property_foreclosures table to record all properties repossessed by the bank
-- 2. Update end_turn and resign_game to record foreclosed properties in property_foreclosures
-- 3. Grant SELECT to authenticated and anon, enable RLS, add to realtime publication

CREATE TABLE IF NOT EXISTS public.property_foreclosures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    property_slug TEXT NOT NULL REFERENCES public.catalog_properties(slug),
    owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    owner_name TEXT NOT NULL,
    round_number INT NOT NULL,
    improvements JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_foreclosures_room_round
ON public.property_foreclosures(room_id, round_number);

-- Enable RLS
ALTER TABLE public.property_foreclosures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view property foreclosures"
    ON public.property_foreclosures FOR SELECT
    TO authenticated, anon
    USING (true);

GRANT SELECT ON public.property_foreclosures TO authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.property_foreclosures FROM PUBLIC, anon, authenticated;

-- Add to Realtime publication
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication 
        WHERE pubname = 'supabase_realtime' 
          AND NOT EXISTS (
              SELECT 1 FROM pg_publication_tables 
              WHERE pubname = 'supabase_realtime' 
                AND schemaname = 'public' 
                AND tablename = 'property_foreclosures'
          )
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.property_foreclosures;
    END IF;
END $$;

-- Update end_turn to record foreclosures in property_foreclosures
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
        -- Record foreclosures in property_foreclosures and return properties to the bank
        -- -------------------------------------------------------------
        FOR v_foreclosed_prop IN
            SELECT gp.*, cp.name AS catalog_name, rp.display_name AS owner_display_name
            FROM public.game_properties gp
            JOIN public.catalog_properties cp ON gp.property_slug = cp.slug
            JOIN public.room_players rp ON gp.room_id = rp.room_id AND gp.owner_user_id = rp.user_id
            WHERE gp.room_id = p_room_id
              AND gp.owner_user_id IS NOT NULL
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
        'foreclosed_properties', v_foreclosed_properties,
        'sold_properties', v_sold_properties,
        'room', row_to_json(v_room)
    );
END;
$$;

-- Update resign_game to also log foreclosures in property_foreclosures
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
    v_new_host_id UUID;
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

    -- Surrender resigning player's properties
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

    SELECT COUNT(*) INTO v_remaining_count
    FROM public.room_players
    WHERE room_id = p_room_id AND user_id != v_user_id;

    IF v_remaining_count = 0 THEN
        UPDATE public.rooms
        SET status = 'abandoned', updated_at = now()
        WHERE id = p_room_id;

        DELETE FROM public.room_players
        WHERE room_id = p_room_id AND user_id = v_user_id;

        RETURN json_build_object(
            'success', true,
            'status', 'abandoned',
            'remaining_count', 0
        );
    END IF;

    IF v_remaining_count = 1 THEN
        SELECT user_id INTO v_winner_user_id
        FROM public.room_players
        WHERE room_id = p_room_id AND user_id != v_user_id
        LIMIT 1;

        IF v_player.is_host THEN
            UPDATE public.room_players
            SET is_host = TRUE
            WHERE room_id = p_room_id AND user_id = v_winner_user_id;

            UPDATE public.rooms
            SET host_id = v_winner_user_id
            WHERE id = p_room_id;
        END IF;

        DELETE FROM public.room_players
        WHERE room_id = p_room_id AND user_id = v_user_id;

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

    -- 2 or more players remain
    IF v_player.is_host THEN
        SELECT user_id INTO v_new_host_id
        FROM public.room_players
        WHERE room_id = p_room_id AND user_id != v_user_id
        ORDER BY seat_number ASC
        LIMIT 1;

        UPDATE public.room_players
        SET is_host = TRUE
        WHERE room_id = p_room_id AND user_id = v_new_host_id;

        UPDATE public.rooms
        SET host_id = v_new_host_id
        WHERE id = p_room_id;
    END IF;

    IF v_room.current_turn_seat = v_player.seat_number THEN
        SELECT seat_number INTO v_next_seat
        FROM public.room_players
        WHERE room_id = p_room_id AND user_id != v_user_id AND seat_number > v_player.seat_number
        ORDER BY seat_number ASC
        LIMIT 1;

        IF v_next_seat IS NULL THEN
            SELECT seat_number INTO v_next_seat
            FROM public.room_players
            WHERE room_id = p_room_id AND user_id != v_user_id
            ORDER BY seat_number ASC
            LIMIT 1;

            v_is_new_round := true;
            v_next_round := v_room.current_round + 1;
        END IF;

        IF v_is_new_round THEN
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
                  AND gp.owner_user_id != v_user_id
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

            -- Foreclosures for remaining players: record in property_foreclosures
            FOR v_foreclosed_prop IN
                SELECT gp.*, cp.name AS catalog_name, rp.display_name AS owner_display_name
                FROM public.game_properties gp
                JOIN public.catalog_properties cp ON gp.property_slug = cp.slug
                JOIN public.room_players rp ON gp.room_id = rp.room_id AND gp.owner_user_id = rp.user_id
                WHERE gp.room_id = p_room_id
                  AND gp.owner_user_id IS NOT NULL
                  AND gp.owner_user_id != v_user_id
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
              AND gp.owner_user_id != v_user_id
              AND gp.last_paid_round < v_room.current_round
              AND gp.missed_payments >= 1;

            -- Delinquency
            UPDATE public.game_properties
            SET missed_payments = 1
            WHERE room_id = p_room_id
              AND owner_user_id IS NOT NULL
              AND owner_user_id != v_user_id
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

    DELETE FROM public.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id;

    RETURN json_build_object(
        'success', true,
        'status', 'in_progress',
        'remaining_count', v_remaining_count,
        'current_turn_seat', v_room.current_turn_seat,
        'current_round', v_room.current_round
    );
END;
$$;
