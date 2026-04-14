import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

interface EmailThread {
  threadId: string;
  subject: string;
  sender: string;
  company: string;
  isNew: boolean;
  summary: string;
  interactions: number;
  lastMessageAt: string;
  keyPoints: string[];
  messages: EmailMessage[];
}

interface EmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
}

const POLL_MS = 120000; // 2 minutes

export default function GmailPanel() {
  const [threads, setThreads] = useState<EmailThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedThread, setExpandedThread] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  const fetchEmails = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);

    try {
      // 1. Fetch emails from Gmail
      const { data: gmailData, error: gmailError } = await supabase.functions.invoke("gmail-proxy", {
        body: { action: "listEmails", maxResults: 30 },
      });

      if (gmailError) throw new Error(gmailError.message);
      const emails = gmailData?.emails || [];

      if (emails.length === 0) {
        setThreads([]);
        setLastSync(new Date());
        if (!silent) setLoading(false);
        return;
      }

      // 2. Group by threadId
      const threadMap = new Map<string, EmailMessage[]>();
      for (const email of emails) {
        const tid = email.threadId || email.id;
        if (!threadMap.has(tid)) threadMap.set(tid, []);
        threadMap.get(tid)!.push(email);
      }

      // 3. Process each thread with AI
      const processed: EmailThread[] = [];

      for (const [threadId, msgs] of threadMap) {
        const firstMsg = msgs[0];
        const isNewThread = msgs.length === 1 && !firstMsg.inReplyTo;

        try {
          const { data: aiData } = await supabase.functions.invoke("openrouter-proxy", {
            body: {
              action: "summarize_email",
              context: {
                emails: msgs.map(m => ({ from: m.from, date: m.date, body: m.body || m.snippet })),
                subject: firstMsg.subject,
                sender: firstMsg.from,
              },
            },
          });

          const senderEmail = firstMsg.from || "";
          const companyMatch = senderEmail.match(/@([^.]+)\./);
          const detectedCompany = aiData?.company || companyMatch?.[1] || "Desconhecido";

          processed.push({
            threadId,
            subject: firstMsg.subject || "Sem assunto",
            sender: firstMsg.from || "Desconhecido",
            company: detectedCompany.charAt(0).toUpperCase() + detectedCompany.slice(1),
            isNew: aiData?.isNew ?? isNewThread,
            summary: aiData?.summary || firstMsg.snippet || "",
            interactions: msgs.length,
            lastMessageAt: msgs[msgs.length - 1]?.date || "",
            keyPoints: aiData?.keyPoints || [],
            messages: msgs,
          });
        } catch {
          // Fallback without AI
          const senderEmail = firstMsg.from || "";
          const companyMatch = senderEmail.match(/@([^.]+)\./);

          processed.push({
            threadId,
            subject: firstMsg.subject || "Sem assunto",
            sender: firstMsg.from || "Desconhecido",
            company: companyMatch?.[1]?.charAt(0).toUpperCase() + (companyMatch?.[1]?.slice(1) || "") || "Desconhecido",
            isNew: isNewThread,
            summary: firstMsg.snippet || "",
            interactions: msgs.length,
            lastMessageAt: msgs[msgs.length - 1]?.date || "",
            keyPoints: [],
            messages: msgs,
          });
        }
      }

      // Sort by last message date (most recent first)
      processed.sort((a, b) => {
        const da = new Date(a.lastMessageAt).getTime() || 0;
        const db = new Date(b.lastMessageAt).getTime() || 0;
        return db - da;
      });

      setThreads(processed);
      setLastSync(new Date());
    } catch (e: any) {
      setError(e.message || "Erro ao buscar emails");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEmails();
    const interval = setInterval(() => fetchEmails(true), POLL_MS);
    return () => clearInterval(interval);
  }, [fetchEmails]);

  // Group threads by company
  const groupedByCompany = threads.reduce((acc, thread) => {
    const company = thread.company || "Outros";
    if (!acc[company]) acc[company] = [];
    acc[company].push(thread);
    return acc;
  }, {} as Record<string, EmailThread[]>);

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch { return dateStr; }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">📧</span>
          <h2 className="text-base font-bold text-foreground">Emails — brunoalmeida@ipe.digital</h2>
          <span className="text-xs bg-primary/10 text-primary font-bold px-2 py-0.5 rounded-full">{threads.length}</span>
        </div>
        <div className="flex items-center gap-2">
          {lastSync && (
            <span className="text-xs text-muted-foreground">
              Sync: {lastSync.toLocaleTimeString("pt-BR")}
            </span>
          )}
          <button
            onClick={() => fetchEmails()}
            disabled={loading}
            className="text-sm border border-border rounded-lg px-3 py-1.5 text-foreground hover:bg-muted transition-colors disabled:opacity-50"
          >
            {loading ? "Carregando..." : "↻ Atualizar"}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && threads.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">Carregando emails...</div>
      )}

      {/* Empty */}
      {!loading && threads.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">Nenhum email encontrado.</div>
      )}

      {/* Grouped by Company */}
      {Object.entries(groupedByCompany)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([company, companyThreads]) => (
          <div key={company} className="bg-card border border-border rounded-xl overflow-hidden">
            {/* Company header */}
            <div className="bg-muted/50 px-4 py-2.5 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-foreground">{company}</span>
                <span className="text-xs bg-primary/10 text-primary font-bold px-1.5 py-0.5 rounded">
                  {companyThreads.length} {companyThreads.length === 1 ? "thread" : "threads"}
                </span>
              </div>
              <div className="flex gap-1">
                {companyThreads.some(t => t.isNew) && (
                  <span className="text-[0.6rem] font-bold px-1.5 py-0.5 rounded bg-vintage-green/20 text-vintage-green">
                    NOVO
                  </span>
                )}
              </div>
            </div>

            {/* Threads */}
            <div className="divide-y divide-border/50">
              {companyThreads.map((thread) => (
                <div key={thread.threadId}>
                  <div
                    className="px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                    onClick={() => setExpandedThread(expandedThread === thread.threadId ? null : thread.threadId)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-[0.6rem] font-bold px-1.5 py-0.5 rounded ${
                            thread.isNew
                              ? "bg-vintage-green/20 text-vintage-green"
                              : "bg-vintage-blue/20 text-vintage-blue"
                          }`}>
                            {thread.isNew ? "NOVO" : "CONTINUACAO"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {thread.interactions} {thread.interactions === 1 ? "msg" : "msgs"}
                          </span>
                        </div>
                        <h4 className="text-sm font-semibold text-foreground truncate">{thread.subject}</h4>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{thread.sender}</p>
                        <p className="text-xs text-foreground/70 mt-1 line-clamp-2">{thread.summary}</p>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <span className="text-[0.65rem] text-muted-foreground">{formatDate(thread.lastMessageAt)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Expanded thread details */}
                  {expandedThread === thread.threadId && (
                    <div className="px-4 pb-4 border-t border-border/30">
                      {/* Key points */}
                      {thread.keyPoints.length > 0 && (
                        <div className="mt-3 mb-3">
                          <span className="text-[0.65rem] uppercase font-bold text-muted-foreground">Pontos-chave</span>
                          <ul className="mt-1 space-y-0.5">
                            {thread.keyPoints.map((point, i) => (
                              <li key={i} className="text-xs text-foreground/80 flex items-start gap-1">
                                <span className="text-primary mt-0.5">•</span>
                                {point}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Messages */}
                      <div className="space-y-2 mt-2">
                        <span className="text-[0.65rem] uppercase font-bold text-muted-foreground">Mensagens</span>
                        {thread.messages.map((msg, i) => (
                          <div key={msg.id || i} className="bg-muted/40 rounded-lg p-3">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-semibold text-foreground">{msg.from}</span>
                              <span className="text-[0.6rem] text-muted-foreground">{formatDate(msg.date)}</span>
                            </div>
                            <p className="text-xs text-foreground/70 whitespace-pre-wrap line-clamp-6">
                              {msg.body || msg.snippet || "Sem conteudo"}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}
