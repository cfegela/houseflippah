-- Migration: Grant SELECT on property_sales for client read access & Realtime subscriptions
-- In migration 13, all tables had direct writes revoked and SELECT granted to authenticated.
-- property_sales was created in migration 17 and requires explicit SELECT permission.

GRANT SELECT ON public.property_sales TO authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.property_sales FROM PUBLIC, anon, authenticated;
