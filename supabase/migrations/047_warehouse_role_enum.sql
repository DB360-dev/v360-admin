-- =====================================================================
-- 047_warehouse_role_enum.sql
-- New V360 membership role for hub (warehouse) staff. The value is added
-- on its own because Postgres can't use a new enum value in the same
-- transaction that adds it; 048 wires up its permissions.
-- =====================================================================

alter type member_role add value if not exists 'warehouse';
