do $$
declare
  v_user_id uuid := 'b297baad-87ba-42ac-9470-ed806fa704e3';
  v_store_name text := 'floresta2';
  v_store_slug text := 'floresta2';
  v_yampi_merchant_id text := '1155404';
  v_store_id uuid;
begin
  insert into integrations.stores (name, slug, active)
  values (v_store_name, v_store_slug, true)
  on conflict (slug) do update
    set name = excluded.name,
        active = true,
        updated_at = now()
  returning id into v_store_id;

  insert into integrations.store_members (store_id, user_id, role)
  values (v_store_id, v_user_id, 'owner')
  on conflict (store_id, user_id) do update
    set role = excluded.role,
        updated_at = now();

  insert into integrations.store_external_links (store_id, source, external_store_id)
  values (v_store_id, 'yampi', v_yampi_merchant_id)
  on conflict (source, external_store_id) do update
    set store_id = excluded.store_id,
        updated_at = now();

  delete from integrations.store_members
  where user_id = v_user_id and store_id <> v_store_id;
end $$;
