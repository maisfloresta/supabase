do $$
declare
  r record;
  new_qual text;
  new_check text;
  admin_qual text;
  public_qual text;
  combined_qual text;
begin
  for r in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and policyname = any(array[
        'profiles_select_own_or_admin',
        'profiles_update_own',
        'orders_select_own_or_admin',
        'order_items_select_via_order',
        'order_sources_select_via_order',
        'order_status_history_select_via_order',
        'wallets_select_own_or_admin',
        'cashback_transactions_select_own_or_admin'
      ])
  loop
    new_qual := r.qual;
    new_check := r.with_check;

    if new_qual is not null then
      if new_qual ~* 'auth\\.uid\\(\\)' and new_qual !~* 'select\\s+auth\\.uid\\(\\)' then
        new_qual := regexp_replace(new_qual, 'auth\\.uid\\(\\)', '(select auth.uid())', 'g');
      end if;
      if new_qual ~* 'auth\\.role\\(\\)' and new_qual !~* 'select\\s+auth\\.role\\(\\)' then
        new_qual := regexp_replace(new_qual, 'auth\\.role\\(\\)', '(select auth.role())', 'g');
      end if;
      if new_qual ~* 'current_setting\\(' and new_qual !~* 'select\\s+current_setting\\(' then
        new_qual := regexp_replace(
          new_qual,
          'current_setting\\(([^\\)]*)\\)',
          '(select current_setting(\\1))',
          'g'
        );
      end if;
      if new_qual is distinct from r.qual then
        execute format(
          'alter policy %I on %I.%I using (%s)',
          r.policyname,
          r.schemaname,
          r.tablename,
          new_qual
        );
      end if;
    end if;

    if new_check is not null then
      if new_check ~* 'auth\\.uid\\(\\)' and new_check !~* 'select\\s+auth\\.uid\\(\\)' then
        new_check := regexp_replace(new_check, 'auth\\.uid\\(\\)', '(select auth.uid())', 'g');
      end if;
      if new_check ~* 'auth\\.role\\(\\)' and new_check !~* 'select\\s+auth\\.role\\(\\)' then
        new_check := regexp_replace(new_check, 'auth\\.role\\(\\)', '(select auth.role())', 'g');
      end if;
      if new_check ~* 'current_setting\\(' and new_check !~* 'select\\s+current_setting\\(' then
        new_check := regexp_replace(
          new_check,
          'current_setting\\(([^\\)]*)\\)',
          '(select current_setting(\\1))',
          'g'
        );
      end if;
      if new_check is distinct from r.with_check then
        execute format(
          'alter policy %I on %I.%I with check (%s)',
          r.policyname,
          r.schemaname,
          r.tablename,
          new_check
        );
      end if;
    end if;
  end loop;

  select qual
    into admin_qual
  from pg_policies
  where schemaname = 'public'
    and tablename = 'products'
    and policyname = 'products_admin_write';

  select qual
    into public_qual
  from pg_policies
  where schemaname = 'public'
    and tablename = 'products'
    and policyname = 'products_public_read_active';

  if admin_qual is not null and public_qual is not null then
    combined_qual := '(' || admin_qual || ') or (' || public_qual || ')';

    if combined_qual ~* 'auth\\.uid\\(\\)' and combined_qual !~* 'select\\s+auth\\.uid\\(\\)' then
      combined_qual := regexp_replace(combined_qual, 'auth\\.uid\\(\\)', '(select auth.uid())', 'g');
    end if;
    if combined_qual ~* 'auth\\.role\\(\\)' and combined_qual !~* 'select\\s+auth\\.role\\(\\)' then
      combined_qual := regexp_replace(combined_qual, 'auth\\.role\\(\\)', '(select auth.role())', 'g');
    end if;
    if combined_qual ~* 'current_setting\\(' and combined_qual !~* 'select\\s+current_setting\\(' then
      combined_qual := regexp_replace(
        combined_qual,
        'current_setting\\(([^\\)]*)\\)',
        '(select current_setting(\\1))',
        'g'
      );
    end if;

    execute format(
      'alter policy %I on public.products using (%s)',
      'products_public_read_active',
      combined_qual
    );
    execute format('drop policy %I on public.products', 'products_admin_write');
  end if;
end $$;
