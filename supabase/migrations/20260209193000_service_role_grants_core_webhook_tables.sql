-- service_role needs access to core tables used by webhook jobs-runner normalization
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'core') then
    grant usage on schema core to service_role;

    if to_regclass('core.status_mappings') is not null then
      grant select on table core.status_mappings to service_role;
    end if;

    if to_regclass('core.orders') is not null then
      grant select, insert, update, delete on table core.orders to service_role;
    end if;

    if to_regclass('core.order_items') is not null then
      grant select, insert, update, delete on table core.order_items to service_role;
    end if;

    if to_regclass('core.order_status_history') is not null then
      grant select, insert, update, delete on table core.order_status_history to service_role;
    end if;

    if to_regclass('core.order_status_history_id_seq') is not null then
      grant usage, select on sequence core.order_status_history_id_seq to service_role;
    end if;
  end if;
end
$$;
