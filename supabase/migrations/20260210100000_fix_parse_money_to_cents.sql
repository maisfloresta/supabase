-- Remove heuristic that treated integer values >= 1000 as already-in-cents.
-- This caused R$ 1.000,00 to be interpreted as R$ 10,00 (1000 cents instead of 100000).
create or replace function public.parse_money_to_cents(value_text text)
returns bigint
language plpgsql
as $$
declare
  cleaned text;
  num numeric;
begin
  if value_text is null or btrim(value_text) = '' then
    return null;
  end if;

  cleaned := regexp_replace(value_text, '[^0-9,.\-]', '', 'g');
  if cleaned = '' then
    return null;
  end if;

  -- If comma is present, treat comma as decimal separator.
  if position(',' in cleaned) > 0 then
    cleaned := replace(replace(cleaned, '.', ''), ',', '.');
    num := cleaned::numeric;
    return round(num * 100)::bigint;
  end if;

  num := cleaned::numeric;

  return round(num * 100)::bigint;
exception
  when others then
    return null;
end;
$$;
