-- Migration: Automated Buyer Pool, Property Sales Tracking & Round-End Settlements
-- 1. Create property_sales table to record all completed sales (Bank and Automated Buyers)
-- 2. Add is_sold_to_buyer to game_properties to permanently remove sold properties (Option B)
-- 3. Update buy_property to record bank purchases in property_sales and block buying sold properties
-- 4. Update end_turn to evaluate listed properties against automated buyer pool at round end
--    - Multiplicative odds adjustment: base_odds * (1 - (list_price - market_value) / market_value)
--    - Mortgage payoff: net_proceeds = list_price - mortgage_balance
--    - Net cash credited to seller, property marked as sold and removed from active play
--    - Sale recorded in property_sales with random buyer name

-- 1. Create property_sales table
CREATE TABLE IF NOT EXISTS public.property_sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    property_slug TEXT NOT NULL REFERENCES public.catalog_properties(slug),
    seller_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    seller_name TEXT NOT NULL DEFAULT 'Bank',
    buyer_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    buyer_name TEXT NOT NULL,
    buyer_type TEXT NOT NULL DEFAULT 'automated', -- 'player' or 'automated'
    sale_price INT NOT NULL,
    mortgage_paid INT NOT NULL DEFAULT 0,
    net_proceeds INT NOT NULL DEFAULT 0,
    round_number INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_sales_room_round
ON public.property_sales(room_id, round_number);

-- Enable RLS on property_sales
ALTER TABLE public.property_sales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow read access to property_sales for room players" ON public.property_sales;
CREATE POLICY "Allow read access to property_sales for room players"
ON public.property_sales FOR SELECT
TO authenticated, anon
USING (
    EXISTS (
        SELECT 1 FROM public.room_players rp
        WHERE rp.room_id = property_sales.room_id
    )
);

-- Enable Realtime for property_sales
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' 
          AND schemaname = 'public' 
          AND tablename = 'property_sales'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.property_sales;
    END IF;
END;
$$;

-- 2. Add is_sold_to_buyer column to game_properties
ALTER TABLE public.game_properties
ADD COLUMN IF NOT EXISTS is_sold_to_buyer BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Update start_game to reset property_sales and initialize is_sold_to_buyer
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

    -- Pick initial random market temperature
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

    -- Clean any existing sales records for this room
    DELETE FROM public.property_sales WHERE room_id = p_room_id;

    -- Seed all 28 properties as Bank-owned with clean initial market_value
    INSERT INTO public.game_properties (
        room_id, property_slug, owner_user_id, purchased_at, purchased_round, missed_payments, last_paid_round,
        is_listed, list_price, listed_round, purchase_price, market_value, improvements, is_sold_to_buyer
    )
    SELECT p_room_id, slug, NULL, NULL, NULL, 0, 0, FALSE, NULL, NULL, NULL, cost, '[]'::jsonb, FALSE
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
        improvements = '[]'::jsonb,
        is_sold_to_buyer = FALSE;

    RETURN json_build_object(
        'success', true,
        'room', row_to_json(v_room)
    );
END;
$$;

-- 4. Update buy_property to record bank purchase in property_sales and block buying sold properties
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

    IF v_room.current_turn_seat != v_player.seat_number THEN
        RAISE EXCEPTION 'It is not your turn';
    END IF;

    -- Enforce 1 property purchase per round per player
    SELECT EXISTS (
        SELECT 1
        FROM public.game_properties
        WHERE room_id = p_room_id
          AND owner_user_id = v_user_id
          AND purchased_round = v_room.current_round
    ) INTO v_already_purchased;

    IF v_already_purchased THEN
        RAISE EXCEPTION 'You can only purchase 1 property per round';
    END IF;

    -- Lock property
    SELECT * INTO v_property
    FROM public.game_properties
    WHERE room_id = p_room_id AND property_slug = p_property_slug
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Property not found in game';
    END IF;

    IF v_property.is_sold_to_buyer THEN
        RAISE EXCEPTION 'This property has been sold to an outside buyer and is no longer available';
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
        RAISE EXCEPTION 'Insufficient cash for 10%% down payment. Required: %, Available: %',
            v_down_payment, v_player.cash;
    END IF;

    -- Deduct down payment from player
    UPDATE public.room_players
    SET cash = cash - v_down_payment,
        last_seen_at = now()
    WHERE id = v_player.id
    RETURNING * INTO v_player;

    -- Assign property to player
    UPDATE public.game_properties
    SET owner_user_id = v_user_id,
        purchased_at = now(),
        purchased_round = v_room.current_round,
        purchase_price = v_catalog.cost,
        last_paid_round = v_room.current_round,
        missed_payments = 0,
        is_listed = FALSE,
        list_price = NULL,
        listed_round = NULL,
        last_listed_round = NULL,
        last_improved_round = NULL
    WHERE id = v_property.id
    RETURNING * INTO v_property;

    -- Record bank sale in property_sales
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
        'down_payment', v_down_payment
    );
END;
$$;

-- 5. Update list_property to prevent listing sold properties and ensure list_price >= mortgage_balance
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

-- 6. Update end_turn to run the automated buyer pool on round transitions
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
            WHEN 'Ice Cold' THEN v_base_odds := 0.20;
            WHEN 'Chilly'   THEN v_base_odds := 0.35;
            WHEN 'Comfy'    THEN v_base_odds := 0.50;
            WHEN 'Toasty'   THEN v_base_odds := 0.65;
            WHEN 'On Fire'  THEN v_base_odds := 0.80;
            ELSE                 v_base_odds := 0.50;
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

-- 7. Grant execution permissions to authenticated users
REVOKE EXECUTE ON FUNCTION public.start_game(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_game(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.buy_property(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buy_property(UUID, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.list_property(UUID, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_property(UUID, TEXT, INT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.end_turn(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_turn(UUID) TO authenticated;
