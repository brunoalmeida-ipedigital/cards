-- Tabela para armazenar e-mails triados pela IA (OpenRouter)
CREATE TABLE IF NOT EXISTS emails_triados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_thread_id TEXT,
  gmail_message_id TEXT UNIQUE,
  assunto TEXT,
  corpo TEXT,
  remetente_nome TEXT,
  remetente_email TEXT,
  -- Análise da IA
  tipo_thread TEXT,                    -- 'novo' | 'continuacao'
  motivo_classificacao TEXT,
  categoria_sistema TEXT,              -- PJBank | TEF | NFe | Boleto Fácil | Outros
  resumo_problema TEXT,
  interacoes_anteriores TEXT,
  sentimento_cliente TEXT,             -- Calmo | Dúvida | Urgente | Irritado
  prioridade_sugerida TEXT,            -- Baixa | Média | Alta | Crítica
  acao_recomendada TEXT,
  -- Status do card
  pipefy_card_id TEXT,
  status TEXT DEFAULT 'pendente',     -- pendente | processado | ignorado
  criado_em BIGINT DEFAULT (extract(epoch from now()) * 1000)::BIGINT
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_emails_triados_status ON emails_triados(status);
CREATE INDEX IF NOT EXISTS idx_emails_triados_prioridade ON emails_triados(prioridade_sugerida);
CREATE INDEX IF NOT EXISTS idx_emails_triados_criado ON emails_triados(criado_em DESC);

-- RLS: permitir leitura/escrita autenticada e pelo service_role
ALTER TABLE emails_triados ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Leitura autenticada" ON emails_triados;
CREATE POLICY "Leitura autenticada" ON emails_triados
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Escrita service_role" ON emails_triados;
CREATE POLICY "Escrita service_role" ON emails_triados
  FOR ALL USING (true);
