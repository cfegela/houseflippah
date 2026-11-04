-- Update leave_room to end the game for all players when the host leaves/ends the game
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
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    SELECT is_host INTO v_was_host
    FROM public.room_players
    WHERE room_id = p_room_id AND user_id = v_user_id;

    IF v_was_host THEN
        -- When host ends the game, update room status to 'abandoned' for all players
        UPDATE public.rooms
        SET status = 'abandoned', updated_at = now()
        WHERE id = p_room_id;

        -- Remove all players from the room
        DELETE FROM public.room_players
        WHERE room_id = p_room_id;
    ELSE
        -- Guest player leaves room
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
