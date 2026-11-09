-- Migration 22: Player Resign Game feature
-- Allows any player (host or guest) to resign from an active game.
-- 1. Resigning forfeits all owned properties back to the bank with mortgage cleared and improvements preserved.
-- 2. If it is the resigning player's turn, advance turn to the next remaining active seat. If turn wraps around, run round advance logic.
-- 3. If resigning player is host, transfer host to the next remaining active player.
-- 4. If exactly 1 player remains, mark room status = 'completed' (sole survivor / winner).
-- 5. If 0 players remain, mark room status = 'abandoned'.
-- 6. Delete resigning player from room_players.

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

    -- Buyer pool variables for round advance (if turn wraps)
    v_base_odds NUMERIC;
    v_num_improvements INT;
    v_effective_base_odds NUMERIC;
    v_effective_odds NUMERIC;
    v_listed_prop RECORD;
    v_random_buyer TEXT;
    v_mortgage_paid INT;
    v_net_proceeds INT;
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

    -- 1. Surrender all properties owned by resigning player back to the bank.
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

    -- Count active players remaining excluding resigning player
    SELECT COUNT(*) INTO v_remaining_count
    FROM public.room_players
    WHERE room_id = p_room_id AND user_id != v_user_id;

    -- Case A: 0 remaining players (game abandoned)
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

    -- Case B: Exactly 1 remaining player (sole survivor / winner!)
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

    -- Case C: 2 or more players remain (game continues)
    -- If resigning player is host, transfer host to lowest seat remaining
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

    -- Advance turn if it is currently the resigning player's turn
    IF v_room.current_turn_seat = v_player.seat_number THEN
        SELECT seat_number INTO v_next_seat
        FROM public.room_players
        WHERE room_id = p_room_id AND user_id != v_user_id AND seat_number > v_player.seat_number
        ORDER BY seat_number ASC
        LIMIT 1;

        IF v_next_seat IS NULL THEN
            -- Wrap around to first remaining seat: advances the round!
            SELECT seat_number INTO v_next_seat
            FROM public.room_players
            WHERE room_id = p_room_id AND user_id != v_user_id
            ORDER BY seat_number ASC
            LIMIT 1;

            v_is_new_round := true;
            v_next_round := v_room.current_round + 1;
        END IF;

        IF v_is_new_round THEN
            -- Automated buyer pool for remaining listed properties
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

            -- Foreclosures for remaining players
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
              AND gp.owner_user_id != v_user_id
              AND gp.last_paid_round < v_room.current_round
              AND gp.missed_payments >= 1;

            -- Delinquency for remaining players
            UPDATE public.game_properties
            SET missed_payments = 1
            WHERE room_id = p_room_id
              AND owner_user_id IS NOT NULL
              AND owner_user_id != v_user_id
              AND last_paid_round < v_room.current_round
              AND missed_payments = 0;

            -- Randomize market temperature
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

    -- Delete resigning player
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

-- Update leave_room to delegate to resign_game when guest leaves an in-progress game
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
        -- When host ends the game via leave_room, update room status to 'abandoned' for all players
        UPDATE public.rooms
        SET status = 'abandoned', updated_at = now()
        WHERE id = p_room_id;

        -- Remove all players from the room
        DELETE FROM public.room_players
        WHERE room_id = p_room_id;
    ELSE
        -- Guest player leaves room
        IF v_room_status = 'in_progress' THEN
            PERFORM public.resign_game(p_room_id);
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
