-- Enable UUID generation extension if not enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Rooms Table
CREATE TABLE IF NOT EXISTS public.rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'in_progress', 'completed', 'abandoned')),
    max_players INT NOT NULL DEFAULT 4 CHECK (max_players >= 2 AND max_players <= 4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for looking up active rooms
CREATE INDEX IF NOT EXISTS idx_rooms_status ON public.rooms(status);
CREATE INDEX IF NOT EXISTS idx_rooms_created_at ON public.rooms(created_at);

-- 2. Room Players Table
CREATE TABLE IF NOT EXISTS public.room_players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name VARCHAR(24) NOT NULL,
    seat_number INT NOT NULL CHECK (seat_number >= 1 AND seat_number <= 4),
    is_host BOOLEAN NOT NULL DEFAULT false,
    is_ready BOOLEAN NOT NULL DEFAULT false,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_room_seat UNIQUE (room_id, seat_number),
    CONSTRAINT uq_room_user UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_players_room_id ON public.room_players(room_id);
CREATE INDEX IF NOT EXISTS idx_room_players_user_id ON public.room_players(user_id);

-- Enable RLS on both tables
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_players ENABLE ROW LEVEL SECURITY;

-- Realtime Publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE public.room_players;

-- RLS Policies:
-- Any signed-in user (including anonymous) can read rooms and player lists
CREATE POLICY "Anyone authenticated can view rooms"
    ON public.rooms FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Anyone authenticated can view room players"
    ON public.room_players FOR SELECT
    TO authenticated
    USING (true);

-- Updates/Deletes: Users can only modify their own player record
CREATE POLICY "Users can update their own player state"
    ON public.room_players FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can leave room"
    ON public.room_players FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- Host can update room state
CREATE POLICY "Host can update room"
    ON public.rooms FOR UPDATE
    TO authenticated
    USING (auth.uid() = host_id)
    WITH CHECK (auth.uid() = host_id);


-- 3. Stored Procedure: Create Room
CREATE OR REPLACE FUNCTION public.create_room(p_display_name TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_clean_name TEXT;
    v_room public.rooms%ROWTYPE;
    v_player public.room_players%ROWTYPE;
    v_recent_room_count INT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Abuse prevention: Rate limit (max 5 rooms per 10 minutes per user)
    SELECT COUNT(*) INTO v_recent_room_count
    FROM public.rooms
    WHERE host_id = v_user_id
      AND created_at > (now() - INTERVAL '10 minutes');

    IF v_recent_room_count >= 5 THEN
        RAISE EXCEPTION 'Rate limit exceeded: You can only create up to 5 rooms every 10 minutes.';
    END IF;

    -- Sanitize display name
    v_clean_name := trim(p_display_name);
    IF length(v_clean_name) < 1 OR length(v_clean_name) > 20 THEN
        RAISE EXCEPTION 'Display name must be between 1 and 20 characters.';
    END IF;

    -- Create room
    INSERT INTO public.rooms (host_id, status, max_players)
    VALUES (v_user_id, 'waiting', 4)
    RETURNING * INTO v_room;

    -- Seat the host as Seat 1
    INSERT INTO public.room_players (room_id, user_id, display_name, seat_number, is_host, is_ready)
    VALUES (v_room.id, v_user_id, v_clean_name, 1, true, true)
    RETURNING * INTO v_player;

    RETURN json_build_object(
        'room', row_to_json(v_room),
        'player', row_to_json(v_player)
    );
END;
$$;


-- 4. Stored Procedure: Join Room (Concurrency safe with row lock)
CREATE OR REPLACE FUNCTION public.join_room(p_room_id UUID, p_display_name TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_clean_name TEXT;
    v_room public.rooms%ROWTYPE;
    v_player public.room_players%ROWTYPE;
    v_player_count INT;
    v_assigned_seat INT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Sanitize display name
    v_clean_name := trim(p_display_name);
    IF length(v_clean_name) < 1 OR length(v_clean_name) > 20 THEN
        RAISE EXCEPTION 'Display name must be between 1 and 20 characters.';
    END IF;

    -- Acquire row-level lock on the room to prevent race conditions when filling the 4th slot
    SELECT * INTO v_room
    FROM public.rooms
    WHERE id = p_room_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Room not found.';
    END IF;

    IF v_room.status != 'waiting' THEN
        RAISE EXCEPTION 'Game is already % and cannot be joined.', v_room.status;
    END IF;

    -- Check if user is ALREADY in this room (reconnection / page refresh)
    SELECT * INTO v_player
    FROM public.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id;

    IF FOUND THEN
        -- Update last seen and display name if changed
        UPDATE public.room_players
        SET display_name = v_clean_name, last_seen_at = now()
        WHERE id = v_player.id
        RETURNING * INTO v_player;

        RETURN json_build_object(
            'room', row_to_json(v_room),
            'player', row_to_json(v_player),
            'reconnected', true
        );
    END IF;

    -- Check room capacity
    SELECT COUNT(*) INTO v_player_count
    FROM public.room_players
    WHERE room_id = p_room_id;

    IF v_player_count >= v_room.max_players THEN
        RAISE EXCEPTION 'Room is full (maximum % players reached).', v_room.max_players;
    END IF;

    -- Find the lowest available seat number (1..4)
    SELECT s.seat INTO v_assigned_seat
    FROM generate_series(1, v_room.max_players) AS s(seat)
    WHERE s.seat NOT IN (
        SELECT seat_number FROM public.room_players WHERE room_id = p_room_id
    )
    ORDER BY s.seat ASC
    LIMIT 1;

    -- Insert new player
    INSERT INTO public.room_players (room_id, user_id, display_name, seat_number, is_host, is_ready)
    VALUES (p_room_id, v_user_id, v_clean_name, v_assigned_seat, false, false)
    RETURNING * INTO v_player;

    RETURN json_build_object(
        'room', row_to_json(v_room),
        'player', row_to_json(v_player),
        'reconnected', false
    );
END;
$$;


-- 5. Stored Procedure: Toggle Ready
CREATE OR REPLACE FUNCTION public.toggle_ready(p_room_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_player public.room_players%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    UPDATE public.room_players
    SET is_ready = NOT is_ready,
        last_seen_at = now()
    WHERE room_id = p_room_id AND user_id = v_user_id
    RETURNING * INTO v_player;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player not found in room.';
    END IF;

    RETURN json_build_object('player', row_to_json(v_player));
END;
$$;


-- 6. Stored Procedure: Leave Room
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
    v_next_host_id UUID;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT is_host INTO v_was_host
    FROM public.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id;

    DELETE FROM public.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id;

    SELECT COUNT(*) INTO v_remaining_count
    FROM public.room_players
    WHERE room_id = p_room_id;

    -- If no players left, abandon the room
    IF v_remaining_count = 0 THEN
        UPDATE public.rooms
        SET status = 'abandoned', updated_at = now()
        WHERE id = p_room_id;
    ELSIF v_was_host THEN
        -- Transfer host to the next remaining player (by lowest seat number)
        SELECT user_id INTO v_next_host_id
        FROM public.room_players
        WHERE room_id = p_room_id
        ORDER BY seat_number ASC
        LIMIT 1;

        UPDATE public.rooms
        SET host_id = v_next_host_id, updated_at = now()
        WHERE id = p_room_id;

        UPDATE public.room_players
        SET is_host = true, is_ready = true
        WHERE room_id = p_room_id AND user_id = v_next_host_id;
    END IF;

    RETURN json_build_object('success', true);
END;
$$;
