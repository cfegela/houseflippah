-- Migration: Track remaining mortgage balance per property (powers the Financial Report balance sheet)
--
-- mortgage_balance = amount still owed on the property.
--   * Purchase:    purchase_price - 10% down payment
--   * Payment:     reduced by the amount paid (1x or 2x of cost / 40), never below 0
--   * Foreclosure: reset to 0 (property returns to the bank)
--
-- Maintained by a BEFORE UPDATE trigger so every existing RPC (buy_property,
-- make_mortgage_payment, end_turn) keeps working without being redefined.

ALTER TABLE public.game_properties
ADD COLUMN IF NOT EXISTS mortgage_balance INT NOT NULL DEFAULT 0;

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
        -- Purchase: financed amount is the price minus the 10% down payment
        NEW.mortgage_balance := NEW.purchase_price - ((NEW.purchase_price * 10) / 100);

    ELSIF OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NULL THEN
        -- Foreclosure: property returns to the bank, debt is cleared
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

DROP TRIGGER IF EXISTS trg_maintain_mortgage_balance ON public.game_properties;
CREATE TRIGGER trg_maintain_mortgage_balance
BEFORE UPDATE ON public.game_properties
FOR EACH ROW
EXECUTE FUNCTION public.maintain_mortgage_balance();

-- Backfill games already in progress (best-effort estimate: one payment per round since purchase)
UPDATE public.game_properties gp
SET mortgage_balance = GREATEST(
    0,
    (COALESCE(gp.purchase_price, cp.cost) - ((COALESCE(gp.purchase_price, cp.cost) * 10) / 100))
    - (GREATEST(0, COALESCE(gp.last_paid_round, 0) - COALESCE(gp.purchased_round, 0)) * (cp.cost / 40))
)
FROM public.catalog_properties cp
WHERE gp.property_slug = cp.slug
  AND gp.owner_user_id IS NOT NULL;
