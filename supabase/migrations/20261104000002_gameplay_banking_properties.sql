-- Migration: Banking and Real Estate Management (Phase 1)

-- 1. Alter Rooms table to track current turn
ALTER TABLE public.rooms 
ADD COLUMN IF NOT EXISTS current_turn_seat INT DEFAULT 1;

-- 2. Alter Room Players table to track player cash (default $100)
ALTER TABLE public.room_players 
ADD COLUMN IF NOT EXISTS cash INT NOT NULL DEFAULT 100;

-- 3. Catalog Properties (Reference table of standard 28 Monopoly deeds)
CREATE TABLE IF NOT EXISTS public.catalog_properties (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    group_name TEXT NOT NULL,
    color_hex TEXT NOT NULL,
    cost INT NOT NULL,
    board_position INT NOT NULL,
    beds INT NOT NULL DEFAULT 3,
    baths INT NOT NULL DEFAULT 2,
    sqft INT NOT NULL DEFAULT 1450
);

-- Seed catalog with 28 standard deeds
INSERT INTO public.catalog_properties (slug, name, group_name, color_hex, cost, board_position, beds, baths, sqft)
VALUES
    ('mediterranean-ave', 'Mediterranean Avenue', 'Brown', '#8b5a2b', 60, 1, 2, 1, 1100),
    ('baltic-ave', 'Baltic Avenue', 'Brown', '#8b5a2b', 60, 3, 2, 1, 1150),
    ('reading-railroad', 'Reading Railroad', 'Railroad', '#475569', 200, 5, 0, 0, 8500),
    ('oriental-ave', 'Oriental Avenue', 'Light Blue', '#38bdf8', 100, 6, 3, 2, 1350),
    ('vermont-ave', 'Vermont Avenue', 'Light Blue', '#38bdf8', 100, 8, 3, 2, 1380),
    ('connecticut-ave', 'Connecticut Avenue', 'Light Blue', '#38bdf8', 120, 9, 3, 2, 1420),
    ('st-charles-place', 'St. Charles Place', 'Pink', '#ec4899', 140, 11, 3, 2, 1550),
    ('electric-company', 'Electric Company', 'Utility', '#eab308', 150, 12, 0, 0, 4200),
    ('states-ave', 'States Avenue', 'Pink', '#ec4899', 140, 13, 3, 2, 1580),
    ('virginia-ave', 'Virginia Avenue', 'Pink', '#ec4899', 160, 14, 4, 2, 1650),
    ('pennsylvania-railroad', 'Pennsylvania Railroad', 'Railroad', '#475569', 200, 15, 0, 0, 9000),
    ('st-james-place', 'St. James Place', 'Orange', '#f97316', 180, 16, 4, 2, 1750),
    ('tennessee-ave', 'Tennessee Avenue', 'Orange', '#f97316', 180, 17, 4, 2, 1800),
    ('new-york-ave', 'New York Avenue', 'Orange', '#f97316', 200, 19, 4, 3, 1950),
    ('kentucky-ave', 'Kentucky Avenue', 'Red', '#ef4444', 220, 21, 4, 3, 2100),
    ('indiana-ave', 'Indiana Avenue', 'Red', '#ef4444', 220, 23, 4, 3, 2150),
    ('illinois-ave', 'Illinois Avenue', 'Red', '#ef4444', 240, 24, 4, 3, 2250),
    ('b-and-o-railroad', 'B. & O. Railroad', 'Railroad', '#475569', 200, 25, 0, 0, 9200),
    ('atlantic-ave', 'Atlantic Avenue', 'Yellow', '#facc15', 260, 26, 5, 3, 2400),
    ('ventnor-ave', 'Ventnor Avenue', 'Yellow', '#facc15', 260, 27, 5, 3, 2450),
    ('water-works', 'Water Works', 'Utility', '#eab308', 150, 28, 0, 0, 4500),
    ('marvin-gardens', 'Marvin Gardens', 'Yellow', '#facc15', 280, 29, 5, 3, 2600),
    ('pacific-ave', 'Pacific Avenue', 'Green', '#22c55e', 300, 31, 5, 4, 2800),
    ('north-carolina-ave', 'North Carolina Avenue', 'Green', '#22c55e', 300, 32, 5, 4, 2900),
    ('pennsylvania-ave', 'Pennsylvania Avenue', 'Green', '#22c55e', 320, 34, 5, 4, 3100),
    ('short-line', 'Short Line', 'Railroad', '#475569', 200, 35, 0, 0, 8800),
    ('park-place', 'Park Place', 'Dark Blue', '#2563eb', 350, 37, 6, 5, 3600),
    ('boardwalk', 'Boardwalk', 'Dark Blue', '#2563eb', 400, 39, 6, 6, 4200)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    group_name = EXCLUDED.group_name,
    color_hex = EXCLUDED.color_hex,
    cost = EXCLUDED.cost,
    board_position = EXCLUDED.board_position,
    beds = EXCLUDED.beds,
    baths = EXCLUDED.baths,
    sqft = EXCLUDED.sqft;

-- 4. Game Properties (per-room instance of deeds)
CREATE TABLE IF NOT EXISTS public.game_properties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    property_slug TEXT NOT NULL REFERENCES public.catalog_properties(slug),
    owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    purchased_at TIMESTAMPTZ,
    CONSTRAINT uq_room_property UNIQUE (room_id, property_slug)
);

CREATE INDEX IF NOT EXISTS idx_game_properties_room ON public.game_properties(room_id);
CREATE INDEX IF NOT EXISTS idx_game_properties_owner ON public.game_properties(owner_user_id);

-- Enable RLS
ALTER TABLE public.catalog_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view catalog properties"
    ON public.catalog_properties FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Anyone authenticated can view game properties"
    ON public.game_properties FOR SELECT
    TO authenticated
    USING (true);

-- Add to Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.game_properties;


-- 5. Stored Procedure: Start Game
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

    IF v_player_count < 2 THEN
        RAISE EXCEPTION 'At least 2 players are required to start the game';
    END IF;

    -- Update room to in_progress with seat 1 starting first
    UPDATE public.rooms
    SET status = 'in_progress',
        current_turn_seat = 1,
        updated_at = now()
    WHERE id = p_room_id
    RETURNING * INTO v_room;

    -- Ensure all players start with $100 cash
    UPDATE public.room_players
    SET cash = 100
    WHERE room_id = p_room_id;

    -- Seed all 28 properties as Bank-owned (owner_user_id = NULL)
    INSERT INTO public.game_properties (room_id, property_slug, owner_user_id)
    SELECT p_room_id, slug, NULL
    FROM public.catalog_properties
    ON CONFLICT (room_id, property_slug) DO UPDATE SET owner_user_id = NULL, purchased_at = NULL;

    RETURN json_build_object(
        'success', true,
        'room', row_to_json(v_room)
    );
END;
$$;


-- 6. Stored Procedure: Buy Property from Bank
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
        RAISE EXCEPTION 'Property not found in game';
    END IF;

    IF v_property.owner_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'Property is already owned';
    END IF;

    -- Get catalog price
    SELECT * INTO v_catalog
    FROM public.catalog_properties
    WHERE slug = p_property_slug;

    IF v_player.cash < v_catalog.cost THEN
        RAISE EXCEPTION 'Insufficient funds: need $%, but you only have $%', v_catalog.cost, v_player.cash;
    END IF;

    -- Deduct cost from player cash
    UPDATE public.room_players
    SET cash = cash - v_catalog.cost,
        last_seen_at = now()
    WHERE id = v_player.id
    RETURNING * INTO v_player;

    -- Transfer ownership to player
    UPDATE public.game_properties
    SET owner_user_id = v_user_id,
        purchased_at = now()
    WHERE id = v_property.id
    RETURNING * INTO v_property;

    RETURN json_build_object(
        'success', true,
        'player', row_to_json(v_player),
        'property', row_to_json(v_property),
        'catalog', row_to_json(v_catalog)
    );
END;
$$;


-- 7. Stored Procedure: End Turn
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
    WHERE room_id = p_room_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player not found in room';
    END IF;

    -- Strict turn check: only active player can end their turn
    IF v_room.current_turn_seat != v_player.seat_number THEN
        RAISE EXCEPTION 'It is not your turn to end';
    END IF;

    -- Find the next active seat in circular order (skipping empty seats)
    SELECT seat_number INTO v_next_seat
    FROM public.room_players
    WHERE room_id = p_room_id AND seat_number > v_player.seat_number
    ORDER BY seat_number ASC
    LIMIT 1;

    IF v_next_seat IS NULL THEN
        -- Wrap around to first seat
        SELECT seat_number INTO v_next_seat
        FROM public.room_players
        WHERE room_id = p_room_id
        ORDER BY seat_number ASC
        LIMIT 1;
    END IF;

    UPDATE public.rooms
    SET current_turn_seat = v_next_seat,
        updated_at = now()
    WHERE id = p_room_id
    RETURNING * INTO v_room;

    RETURN json_build_object(
        'success', true,
        'current_turn_seat', v_next_seat,
        'room', row_to_json(v_room)
    );
END;
$$;
