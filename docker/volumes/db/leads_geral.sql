-- ============================================================
-- LEADS GERAL - Consolidação de Leads + Exclusão de Compradores
-- ============================================================

-- 1. Função de normalização de telefone
-- Entrada: qualquer formato (+5511999..., 11999..., etc)
-- Saída: 11 dígitos (DDD + 9 + número) ou NULL se inválido
CREATE OR REPLACE FUNCTION public.normalize_phone(raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  digits TEXT;
BEGIN
  IF raw IS NULL OR raw = '' THEN RETURN NULL; END IF;

  -- Remove tudo que não é dígito
  digits := regexp_replace(raw, '[^0-9]', '', 'g');

  -- Remove prefixo internacional 55 se ficou com mais de 11 dígitos
  IF length(digits) > 11 AND left(digits, 2) = '55' THEN
    digits := substring(digits FROM 3);
  END IF;

  -- Se tem 10 dígitos (DDD + 8 dígitos sem o 9), adiciona o 9
  IF length(digits) = 10 THEN
    digits := left(digits, 2) || '9' || substring(digits FROM 3);
  END IF;

  -- Deve ter exatamente 11 dígitos
  IF length(digits) != 11 THEN RETURN NULL; END IF;

  -- DDD válido (11-99)
  IF left(digits, 2)::int < 11 THEN RETURN NULL; END IF;

  RETURN digits;
END;
$$;

-- 2. Tabela leads_geral
CREATE TABLE IF NOT EXISTS public.leads_geral (
  id SERIAL PRIMARY KEY,
  nome TEXT,
  telefone TEXT NOT NULL,              -- normalizado: 11 dígitos (ex: 11999887766)
  telefone_e164 TEXT GENERATED ALWAYS AS ('55' || telefone) STORED,  -- para Evolution API
  email TEXT,
  source TEXT,                         -- 'quiz_leads', 'gwq_leads', 'typebot_Fluxo_1.5', etc.
  status TEXT NOT NULL DEFAULT 'new',  -- new, contacted, purchased, cold, error
  campaign_id TEXT,                    -- qual campanha enviou
  contacted_at TIMESTAMPTZ,
  contacted_via TEXT,                  -- nome da instância WhatsApp que enviou
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(telefone)
);

CREATE INDEX IF NOT EXISTS idx_leads_geral_status ON public.leads_geral(status);
CREATE INDEX IF NOT EXISTS idx_leads_geral_telefone ON public.leads_geral(telefone);
CREATE INDEX IF NOT EXISTS idx_leads_geral_created ON public.leads_geral(created_at);

-- 3. Trigger para atualizar updated_at
CREATE OR REPLACE FUNCTION public.leads_geral_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leads_geral_updated ON public.leads_geral;
CREATE TRIGGER trg_leads_geral_updated
  BEFORE UPDATE ON public.leads_geral
  FOR EACH ROW EXECUTE FUNCTION public.leads_geral_updated_at();

-- 4. Função para popular leads de fontes internas do Supabase
CREATE OR REPLACE FUNCTION public.populate_leads_geral()
RETURNS TABLE(source_name TEXT, inserted_count BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  cnt BIGINT;
BEGIN
  -- quiz_leads
  INSERT INTO public.leads_geral (nome, telefone, source, created_at)
  SELECT ql.nome, normalize_phone(ql.telefone), 'quiz_leads', ql.created_at
  FROM public.quiz_leads ql
  WHERE normalize_phone(ql.telefone) IS NOT NULL
  ON CONFLICT (telefone) DO NOTHING;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  source_name := 'quiz_leads'; inserted_count := cnt; RETURN NEXT;

  -- gwq_leads
  INSERT INTO public.leads_geral (nome, telefone, source, created_at)
  SELECT gl.nome, normalize_phone(gl.telefone), 'gwq_leads', gl.created_at
  FROM public.gwq_leads gl
  WHERE normalize_phone(gl.telefone) IS NOT NULL
  ON CONFLICT (telefone) DO NOTHING;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  source_name := 'gwq_leads'; inserted_count := cnt; RETURN NEXT;

  -- yampi customers (que NÃO necessariamente compraram, mas são leads)
  INSERT INTO public.leads_geral (nome, telefone, email, source, created_at)
  SELECT yc.name, normalize_phone(yc.phone_full_number), yc.email, 'yampi', yc.first_seen_at
  FROM yampi.customers yc
  WHERE normalize_phone(yc.phone_full_number) IS NOT NULL
  ON CONFLICT (telefone) DO NOTHING;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  source_name := 'yampi'; inserted_count := cnt; RETURN NEXT;

  -- cartpanda customers
  INSERT INTO public.leads_geral (nome, telefone, email, source, created_at)
  SELECT COALESCE(cc.first_name || ' ' || cc.last_name, cc.first_name),
         normalize_phone(cc.phone), cc.email, 'cartpanda', cc.first_seen_at
  FROM cartpanda.customers cc
  WHERE normalize_phone(cc.phone) IS NOT NULL
  ON CONFLICT (telefone) DO NOTHING;
  GET DIAGNOSTICS cnt = ROW_COUNT;
  source_name := 'cartpanda'; inserted_count := cnt; RETURN NEXT;
END;
$$;

-- 5. Função para marcar leads que já compraram
-- REGRA: se tem pedido PAGO em qualquer plataforma, NÃO pode receber promoção
CREATE OR REPLACE FUNCTION public.mark_purchased_leads()
RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
  cnt BIGINT;
BEGIN
  UPDATE public.leads_geral lg
  SET status = 'purchased', updated_at = NOW()
  WHERE lg.status != 'purchased'
    AND lg.telefone IN (
      -- quiz_orders pagos
      SELECT normalize_phone(customer_phone)
      FROM public.quiz_orders WHERE payment_status = 'paid'

      UNION

      -- gwq_orders pagos
      SELECT normalize_phone(customer_phone)
      FROM public.gwq_orders WHERE payment_status = 'paid'

      UNION

      -- sprout_orders pagos
      SELECT normalize_phone(customer_phone)
      FROM public.sprout_orders WHERE payment_status = 'paid'

      UNION

      -- yampi orders pagos (join com customers pelo telefone)
      SELECT normalize_phone(yc.phone_full_number)
      FROM yampi.orders yo
      JOIN yampi.customers yc ON yc.id = yo.yampi_customer_ref_id
      WHERE yo.payment_status = 'paid'

      UNION

      -- cartpanda orders pagos (payment_status = '3' = paid)
      SELECT normalize_phone(co.phone)
      FROM cartpanda.orders co
      WHERE co.payment_status = '3'
    );

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$;

-- 6. View de leads prontos para envio
-- Só envia para leads com status 'new' que entraram há mais de 24h
CREATE OR REPLACE VIEW public.v_leads_sendable AS
SELECT *
FROM public.leads_geral
WHERE status = 'new'
  AND created_at < NOW() - INTERVAL '24 hours'
ORDER BY created_at ASC;

-- 7. Habilitar RLS mas permitir acesso via service_role
ALTER TABLE public.leads_geral ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leads_geral_service_role ON public.leads_geral;
CREATE POLICY leads_geral_service_role ON public.leads_geral
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Garantir que o PostgREST (service_role) tem acesso
GRANT ALL ON public.leads_geral TO service_role;
GRANT ALL ON public.leads_geral TO postgres;
GRANT USAGE, SELECT ON SEQUENCE leads_geral_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE leads_geral_id_seq TO postgres;
GRANT SELECT ON public.v_leads_sendable TO service_role;
GRANT SELECT ON public.v_leads_sendable TO postgres;
-- Trigger: quando um lead é inserido em quiz_leads ou gwq_leads,
-- automaticamente insere na leads_geral

CREATE OR REPLACE FUNCTION public.sync_lead_to_geral()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  norm_phone TEXT;
  src TEXT;
BEGIN
  norm_phone := normalize_phone(NEW.telefone);
  IF norm_phone IS NULL THEN RETURN NEW; END IF;

  -- Determinar source baseado na tabela de origem
  src := TG_TABLE_NAME; -- 'quiz_leads' ou 'gwq_leads'

  INSERT INTO public.leads_geral (nome, telefone, source, created_at)
  VALUES (NEW.nome, norm_phone, src, COALESCE(NEW.created_at, NOW()))
  ON CONFLICT (telefone) DO UPDATE
    SET nome = COALESCE(NULLIF(TRIM(EXCLUDED.nome), ''), leads_geral.nome)
    WHERE leads_geral.nome IS NULL OR leads_geral.nome = '';

  RETURN NEW;
END;
$$;

-- Trigger em quiz_leads
DROP TRIGGER IF EXISTS trg_sync_quiz_lead ON public.quiz_leads;
CREATE TRIGGER trg_sync_quiz_lead
  AFTER INSERT ON public.quiz_leads
  FOR EACH ROW EXECUTE FUNCTION public.sync_lead_to_geral();

-- Trigger em gwq_leads
DROP TRIGGER IF EXISTS trg_sync_gwq_lead ON public.gwq_leads;
CREATE TRIGGER trg_sync_gwq_lead
  AFTER INSERT ON public.gwq_leads
  FOR EACH ROW EXECUTE FUNCTION public.sync_lead_to_geral();

-- Trigger: quando um pedido é atualizado para 'paid', marca o lead como purchased
CREATE OR REPLACE FUNCTION public.sync_order_purchased()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  norm_phone TEXT;
BEGIN
  -- Só reage quando payment_status muda para 'paid'
  IF NEW.payment_status = 'paid' AND (OLD.payment_status IS NULL OR OLD.payment_status != 'paid') THEN
    norm_phone := normalize_phone(NEW.customer_phone);
    IF norm_phone IS NOT NULL THEN
      UPDATE public.leads_geral
      SET status = 'purchased', updated_at = NOW()
      WHERE telefone = norm_phone AND status != 'purchased';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger em quiz_orders
DROP TRIGGER IF EXISTS trg_order_purchased_quiz ON public.quiz_orders;
CREATE TRIGGER trg_order_purchased_quiz
  AFTER UPDATE ON public.quiz_orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_order_purchased();

-- Trigger em gwq_orders
DROP TRIGGER IF EXISTS trg_order_purchased_gwq ON public.gwq_orders;
CREATE TRIGGER trg_order_purchased_gwq
  AFTER UPDATE ON public.gwq_orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_order_purchased();

-- Trigger em sprout_orders
DROP TRIGGER IF EXISTS trg_order_purchased_sprout ON public.sprout_orders;
CREATE TRIGGER trg_order_purchased_sprout
  AFTER UPDATE ON public.sprout_orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_order_purchased();
