-- Migration 26: Set mortgage balance to full purchase price upon purchase
--
-- Simulates a 10% simple interest rate:
-- Buyer pays 10% down at purchase.
-- The buyer still owes the full purchase price on the mortgage, payable in 40 payments of 1/40th.
-- E.g. Vermont Avenue ($100k cost): $10k down payment, $100k mortgage balance, 40 payments of $2,500.

-- 1. Update the BEFORE UPDATE trigger function on game_properties
CREATE OR REPLACE FUNCTION public.maintain_mortgage_balance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cost INT;
    v_base_payment INT;
    v_paid INT;
BEGIN
    IF OLD.owner_user_id IS NULL AND NEW.owner_user_id IS NOT NULL THEN
        -- Purchase: financed mortgage balance is the full purchase price
        NEW.mortgage_balance := NEW.purchase_price;

    ELSIF OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NULL THEN
        -- Foreclosure / Forfeiture: property returns to the bank, debt is cleared
        NEW.mortgage_balance := 0;

    ELSIF NEW.owner_user_id IS NOT NULL
          AND NEW.owner_user_id = OLD.owner_user_id
          AND NEW.last_paid_round > OLD.last_paid_round THEN
        -- Mortgage payment: 1x, or 2x when a delinquent mortgage is brought current
        SELECT cost INTO v_cost FROM public.catalog_properties WHERE slug = NEW.property_slug;
        v_base_payment := COALESCE(v_cost, NEW.purchase_price) / 40;
        v_paid := CASE
            WHEN OLD.missed_payments >= 1 AND NEW.missed_payments = 0 THEN v_base_payment * 2
            ELSE v_base_payment
        END;
        NEW.mortgage_balance := GREATEST(0, OLD.mortgage_balance - v_paid);
    END IF;

    RETURN NEW;
END;
$$;

-- 2. Update buy_property RPC to set initial mortgage_balance to full catalog cost
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
        mortgage_balance = v_catalog.cost
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
        'player', row_to_json(v_player)
    );
END;
$$;

-- 3. Adjust active games to reflect full purchase price minus payments made
UPDATE public.game_properties gp
SET mortgage_balance = GREATEST(
    0,
    COALESCE(gp.purchase_price, cp.cost)
    - (GREATEST(0, COALESCE(gp.last_paid_round, 0) - COALESCE(gp.purchased_round, 0)) * (cp.cost / 40))
)
FROM public.catalog_properties cp
WHERE gp.property_slug = cp.slug
  AND gp.owner_user_id IS NOT NULL
  AND gp.is_sold_to_buyer = FALSE;
