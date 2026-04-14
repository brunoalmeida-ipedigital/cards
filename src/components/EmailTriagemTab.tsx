import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";

// ── Tipos ──────────────────────────────────────────────────────────────
export interface EmailTriado {
  id: string;
  gmail_message_id: string;
  gmail_thread_id: string;
  assunto: string;
  corpo: string;
  remetente_nome: string;
  remetente_email: string;
  tipo_thread: "novo" | "continuacao";
  motivo_classificacao: string;
  categoria_sistema: string;
  resumo_problema: string;
  interacoes_anteriores: string;
  sentimento_cliente: "Calmo" | "Dúvida" | "Urgente" | "Irritado";
  prioridade_sugerida: "Baixa" | "Média" | "Alta" | "Crítica";
  acao_recomendada: string;
  pipefy_card_id: string | null;
  status: "pendente" | "processado" | "ignorado";
  criado_em: number;
}

// ── Helpers visuais ────────────────────────────────────────────────────
const PRIORIDADE_STYLES: Record<string, string> = {
  Crítica: "bg-red-500/20 text-red-400 border border-red-500/50",
  Alta: "bg-orange-500/20 text-orange-400 border border-orange-500/50",
  Média: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/50",
  Baixa: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/50",
};

const SENTIMENTO_STYLES: Record<string, string> = {
  Irritado: "bg-red-500/10 text-red-400",
  Urgente: "bg-orange-500/10 text-orange-400",
  Dúvida: "bg-blue-500/10 text-blue-400",
  Calmo: "bg-emerald-500/10 text-emerald-400",
};

const SENTIMENTO_EMOJI: Record<string, string> = {
  Irritado: "😡",
  Urgente: "⚡",
  Dúvida: "🤔",
  Calmo: "😊",
};

const SISTEMA_STYLES: Record<string, string> = {
  TEF: "bg-orange-500 text-white",
  NFe: "bg-orange-600 text-white",
  PJBank: "bg-purple-600 text-white",
  "Boleto Fácil": "bg-slate-500 text-white",
  Outros: "bg-slate-400 text-white",
};

const fmtDate = (ts: number) => {
  const d = new Date(ts);
  return d.toLocaleDateString("pt-BR") + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
};

// ── Componente principal ───────────────────────────────────────────────
export default function EmailTriagemTab() {
  const [emails, setEmails] = useState<EmailTriado[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fPrioridade, setFPrioridade] = useState("");
  const [fSistema, setFSistema] = useState("");
  const [fStatus, setFStatus] = useState("pendente");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // ── Carrega e-mails do Supabase ──
  const loadEmails = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("emails_triados")
      .select("*")
      .order("criado_em", { ascending: false })
      .limit(100);

    if (!error && data) setEmails(data as EmailTriado[]);
    setLoading(false);
  };

  useEffect(() => {
    loadEmails();

    // Realtime subscription
    const channel = supabase
      .channel("emails_triados_rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "emails_triados" }, () => {
        loadEmails();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // ── Executar classifier manualmente ──
  const runClassifier = async () => {
    setRunning(true);
    try {
      await supabase.functions.invoke("email-classifier");
      await loadEmails();
    } catch (e) {
      console.error("Classifier error:", e);
    }
    setRunning(false);
  };

  // ── Atualizar status ──
  const updateStatus = async (id: string, status: EmailTriado["status"]) => {
    await supabase.from("emails_triados").update({ status }).eq("id", id);
    setEmails(prev => prev.map(e => e.id === id ? { ...e, status } : e));
  };

  // ── Copiar resumo ──
  const copyResumo = (email: EmailTriado) => {
    const text = `📧 E-MAIL TRIADO — IA\n\nDe: ${email.remetente_nome} <${email.remetente_email}>\nAssunto: ${email.assunto}\nSistema: ${email.categoria_sistema}\nPrioridade: ${email.prioridade_sugerida}\nSentimento: ${email.sentimento_cliente}\n\nResumo: ${email.resumo_problema}\n\nAção: ${email.acao_recomendada}`;
    navigator.clipboard.writeText(text);
    setCopiedId(email.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // ── Filtros ──
  const filtered = useMemo(() => {
    return emails.filter(e => {
      const mp = !fPrioridade || e.prioridade_sugerida === fPrioridade;
      const ms = !fSistema || e.categoria_sistema === fSistema;
      const mst = !fStatus || e.status === fStatus;
      return mp && ms && mst;
    });
  }, [emails, fPrioridade, fSistema, fStatus]);

  const pendentes = emails.filter(e => e.status === "pendente").length;
  const criticos = emails.filter(e => e.prioridade_sugerida === "Crítica" && e.status === "pendente").length;

  return (
    <div className="space-y-4">
      {/* Header com KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <div className="text-[0.65rem] uppercase font-bold text-muted-foreground">Total E-mails</div>
          <div className="text-3xl font-extrabold text-foreground">{emails.length}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <div className="text-[0.65rem] uppercase font-bold text-muted-foreground">Pendentes</div>
          <div className="text-3xl font-extrabold text-yellow-500">{pendentes}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <div className="text-[0.65rem] uppercase font-bold text-muted-foreground">Críticos</div>
          <div className="text-3xl font-extrabold text-red-500">{criticos}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <div className="text-[0.65rem] uppercase font-bold text-muted-foreground">Processados</div>
          <div className="text-3xl font-extrabold text-emerald-500">
            {emails.filter(e => e.status === "processado").length}
          </div>
        </div>
      </div>

      {/* Barra de filtros + botão de sync */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={runClassifier}
          disabled={running}
          className={`text-sm font-bold px-4 py-2 rounded-lg transition-all flex items-center gap-2 ${
            running
              ? "bg-muted text-muted-foreground cursor-wait"
              : "bg-primary text-primary-foreground hover:opacity-90"
          }`}
        >
          {running ? (
            <><span className="animate-spin">⟳</span> Classificando...</>
          ) : (
            <>📧 Buscar E-mails Agora</>
          )}
        </button>

        <select
          value={fStatus}
          onChange={e => setFStatus(e.target.value)}
          className="text-sm bg-card border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary"
        >
          <option value="">Todos status</option>
          <option value="pendente">⏳ Pendentes</option>
          <option value="processado">✅ Processados</option>
          <option value="ignorado">⛔ Ignorados</option>
        </select>

        <select
          value={fPrioridade}
          onChange={e => setFPrioridade(e.target.value)}
          className="text-sm bg-card border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary"
        >
          <option value="">Toda prioridade</option>
          <option value="Crítica">🔴 Crítica</option>
          <option value="Alta">🟠 Alta</option>
          <option value="Média">🟡 Média</option>
          <option value="Baixa">🟢 Baixa</option>
        </select>

        <select
          value={fSistema}
          onChange={e => setFSistema(e.target.value)}
          className="text-sm bg-card border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary"
        >
          <option value="">Todos sistemas</option>
          <option value="NFe">NFe</option>
          <option value="TEF">TEF</option>
          <option value="PJBank">PJBank</option>
          <option value="Boleto Fácil">Boleto Fácil</option>
          <option value="Outros">Outros</option>
        </select>

        <div className="ml-auto text-xs text-muted-foreground font-medium">
          📋 {filtered.length} e-mail(s)
        </div>
      </div>

      {/* Lista de e-mails */}
      {loading ? (
        <div className="text-center py-16 text-muted-foreground">
          <div className="animate-spin text-4xl mb-3">⟳</div>
          <p className="text-sm">Carregando e-mails...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <div className="text-4xl mb-3">📭</div>
          <p className="text-sm">Nenhum e-mail encontrado com esses filtros.</p>
          <button
            onClick={runClassifier}
            className="mt-4 text-sm text-primary hover:underline"
          >
            Buscar novos e-mails →
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(email => {
            const isExpanded = expandedId === email.id;
            const isCritico = email.prioridade_sugerida === "Crítica";
            const isAlta = email.prioridade_sugerida === "Alta";

            return (
              <div
                key={email.id}
                className={`rounded-xl border transition-all duration-200 overflow-hidden ${
                  isCritico
                    ? "border-red-500 card-fire"
                    : isAlta
                    ? "border-orange-500/50"
                    : "border-border"
                } bg-card hover:shadow-medium`}
              >
                {/* Linha compacta */}
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
                  onClick={() => setExpandedId(isExpanded ? null : email.id)}
                >
                  {/* Prioridade badge */}
                  <span className={`text-[0.6rem] font-bold px-2 py-0.5 rounded flex-shrink-0 ${PRIORIDADE_STYLES[email.prioridade_sugerida] || ""}`}>
                    {email.prioridade_sugerida}
                  </span>

                  {/* Sistema badge */}
                  <span className={`text-[0.6rem] font-bold px-2 py-0.5 rounded flex-shrink-0 ${SISTEMA_STYLES[email.categoria_sistema] || "bg-slate-400 text-white"}`}>
                    {email.categoria_sistema}
                  </span>

                  {/* Tipo thread */}
                  <span className={`text-[0.6rem] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${
                    email.tipo_thread === "novo"
                      ? "bg-blue-500/20 text-blue-400"
                      : "bg-purple-500/20 text-purple-400"
                  }`}>
                    {email.tipo_thread === "novo" ? "🆕 Novo" : "🔁 Thread"}
                  </span>

                  {/* Remetente + assunto */}
                  <div className="flex-1 min-w-0">
                    <span className="font-bold text-sm text-foreground truncate block">
                      {email.remetente_nome || email.remetente_email}
                    </span>
                    <span className="text-xs text-muted-foreground truncate block">
                      {email.assunto}
                    </span>
                  </div>

                  {/* Sentimento */}
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded flex-shrink-0 ${SENTIMENTO_STYLES[email.sentimento_cliente] || ""}`}>
                    {SENTIMENTO_EMOJI[email.sentimento_cliente]} {email.sentimento_cliente}
                  </span>

                  {/* Data */}
                  <span className="text-[0.65rem] text-muted-foreground flex-shrink-0 hidden md:block">
                    {fmtDate(email.criado_em)}
                  </span>

                  {/* Status indicator */}
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    email.status === "processado"
                      ? "bg-emerald-500"
                      : email.status === "ignorado"
                      ? "bg-muted-foreground"
                      : "bg-yellow-500 animate-pulse"
                  }`} title={email.status} />

                  {/* Chevron */}
                  <span className={`text-muted-foreground transition-transform duration-300 flex-shrink-0 ${isExpanded ? "rotate-180" : ""}`}>
                    ▾
                  </span>
                </div>

                {/* Detalhes expandidos */}
                {isExpanded && (
                  <div className="px-4 pb-4 pt-1 border-t border-border/50 space-y-3">
                    {/* Resumo do problema */}
                    <div className="bg-muted/50 rounded-lg p-3">
                      <div className="text-[0.65rem] uppercase font-bold text-muted-foreground mb-1">🤖 Resumo da IA</div>
                      <p className="text-sm text-foreground">{email.resumo_problema}</p>
                      {email.interacoes_anteriores && email.interacoes_anteriores !== "N/A" && (
                        <p className="text-xs text-muted-foreground mt-1 italic">
                          Histórico: {email.interacoes_anteriores}
                        </p>
                      )}
                    </div>

                    {/* Ação recomendada */}
                    <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
                      <div className="text-[0.65rem] uppercase font-bold text-primary mb-1">⚡ Ação Recomendada</div>
                      <p className="text-sm font-semibold text-foreground">{email.acao_recomendada}</p>
                    </div>

                    {/* Info do card Pipefy se criado */}
                    {email.pipefy_card_id && (
                      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 flex items-center gap-2">
                        <span className="text-emerald-400">✅</span>
                        <span className="text-sm text-emerald-400 font-semibold">
                          Card Pipefy criado automaticamente — ID: {email.pipefy_card_id}
                        </span>
                      </div>
                    )}

                    {/* Corpo do e-mail */}
                    <details className="group">
                      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                        📄 Ver corpo do e-mail
                      </summary>
                      <pre className="mt-2 text-xs text-muted-foreground bg-muted rounded-lg p-3 whitespace-pre-wrap max-h-48 overflow-y-auto">
                        {email.corpo}
                      </pre>
                    </details>

                    {/* Ações */}
                    <div className="flex items-center gap-2 pt-1 border-t border-border/30">
                      <button
                        onClick={() => copyResumo(email)}
                        className="text-xs px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted transition-colors flex items-center gap-1"
                        title="Copiar resumo"
                      >
                        {copiedId === email.id ? "✅ Copiado!" : "📋 Copiar resumo"}
                      </button>

                      <div className="flex-1" />

                      {email.status !== "ignorado" && (
                        <button
                          onClick={() => updateStatus(email.id, "ignorado")}
                          className="text-xs px-3 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        >
                          ⛔ Ignorar
                        </button>
                      )}

                      {email.status === "pendente" && (
                        <button
                          onClick={() => updateStatus(email.id, "processado")}
                          className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 font-semibold hover:bg-emerald-500/30 transition-colors border border-emerald-500/30"
                        >
                          ✅ Marcar como Processado
                        </button>
                      )}

                      {email.status !== "pendente" && (
                        <button
                          onClick={() => updateStatus(email.id, "pendente")}
                          className="text-xs px-3 py-1.5 rounded-lg bg-yellow-500/20 text-yellow-500 font-semibold hover:bg-yellow-500/30 transition-colors border border-yellow-500/30"
                        >
                          ↩ Reabrir
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
