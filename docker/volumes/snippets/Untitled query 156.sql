-- =========================
-- YAMPI - PAYMENT STATUS
-- =========================
insert into core.status_mappings (source, kind, source_status, canonical_status, notes)
values
  ('yampi','payment','waiting_payment','pending','Aguardando pagamento'),
  ('yampi','payment','pending','pending','Pendente'),
  ('yampi','payment','paid','paid','Pago'),
  ('yampi','payment','canceled','canceled','Cancelado'),
  ('yampi','payment','cancelled','canceled','Cancelado (variação)'),
  ('yampi','payment','refunded','refunded','Reembolsado'),
  ('yampi','payment','chargeback','chargeback','Chargeback')
on conflict (source, kind, source_status)
do update set canonical_status = excluded.canonical_status, notes = excluded.notes;

-- =========================
-- YAMPI - FULFILLMENT STATUS (ajuste conforme você ver no payload)
-- =========================
insert into core.status_mappings (source, kind, source_status, canonical_status, notes)
values
  ('yampi','fulfillment','unfulfilled','unfulfilled','Sem separação/envio'),
  ('yampi','fulfillment','processing','processing','Separando/Processando'),
  ('yampi','fulfillment','shipped','shipped','Enviado'),
  ('yampi','fulfillment','in_transit','shipped','Em transporte'),
  ('yampi','fulfillment','delivered','delivered','Entregue'),
  ('yampi','fulfillment','returned','returned','Devolvido'),
  ('yampi','fulfillment','exception','exception','Problema/Exceção')
on conflict (source, kind, source_status)
do update set canonical_status = excluded.canonical_status, notes = excluded.notes;
