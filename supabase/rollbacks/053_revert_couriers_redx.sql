-- ROLLBACK for migrations/053_couriers_redx.sql
-- Removes the courier tables, functions and permission. Orders keep the
-- courier name / tracking already written on them, and their history.
-- The Vault secret holding the API token is deleted too.
-- Run by hand in the Supabase SQL editor.

begin;

delete from vault.secrets where id in (select token_secret_id from courier_accounts where token_secret_id is not null);

drop function if exists courier_apply_status(text, text, text, text, jsonb);
drop function if exists courier_record_booking(uuid, text, text, text, text);
drop function if exists get_courier_credentials(text);
drop function if exists regenerate_courier_webhook_token(text);
drop function if exists courier_account_secrets(text);
drop function if exists save_courier_account(text, boolean, text, text, text, text, text, text, integer, text);
drop function if exists can_manage_couriers();

drop table if exists courier_events;
drop table if exists courier_parcels;
drop table if exists courier_area_aliases;
drop table if exists courier_areas;
drop table if exists courier_brand_stores;
drop table if exists courier_accounts;

delete from permissions where key = 'couriers.manage';   -- role grants cascade

commit;
