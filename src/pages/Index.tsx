import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import AttendanceCard, { type Atendimento } from "@/components/AttendanceCard";
import Dashboard from "@/components/Dashboard";
import GmailPanel from "@/components/GmailPanel";
import { calcBusinessElapsed, calcBusinessRemaining } from "@/lib/businessHours";

// ── Config ────────────────────────────────────────────────────────
const PIPE_ID = "823783";
const POLL_MS = 60000;
const DONE_PHASES = new Set(["Finalizado", "Arquivado", "Concluido", "Concluído", "Finalizado em", "FINALIZADO EM"]);

const ETAPAS = [
  "Caixa de entrada", "Analista Selecionado", "Hora primeiro contato",
  "Cliente Agendado/Reagendado", "Parado", "Em Configuração",
  "Finalizado em", "Arquivado", "Concluído"
];

const CHEX: Record<string, string> = {
  NFe: "#2563eb", "NFe SC": "#7c3aed", "Boleto Fácil": "#0891b2",
  "Boleto Tradicional": "#0369a1", TEF: "#15803d", Impressora: "#ea580c", Etiqueta: "#d97706",
};

const LIM = 4 * 3600000;
const AV20 = 20 * 60000;
const AV05 = 5 * 60000;

// ── Pipefy via Edge Function ──
const pipefyQuery = async (query: string, variables: Record<string, unknown> = {}) => {
  const { data, error } = await supabase.functions.invoke("pipefy-proxy", {
    body: { query, variables },
  });
  if (error) throw new Error(`Pipefy proxy error: ${error.message}`);
  if (data?.errors?.length) throw new Error(data.errors[0].message);
  return data?.data || data;
};

// ── Slack via Edge Function ──
const slackNotify = async (payload: Record<string, unknown>) => {
  try {
    const analista = String(payload.analista || "").toUpperCase();
    if (analista !== "BRUNO") return;
    await supabase.functions.invoke("slack-notify", { body: payload });
  } catch (e) {
    console.warn("Slack notify failed:", e);
  }
};

// ── DB helpers ──
const upsertAtendimento = async (a: Atendimento) => {
  const row = {
    pipefy_card_id: a.id,
    lic: a.lic || "",
    cli: a.cli || "",
    cel: a.cel || "",
    clas: a.clas || "NFe",
    dem: a.dem || "Média",
    stat: a.stat || "",
    etapa: a.etapa || "Caixa de entrada",
    analista: a.analista || "",
    comentario: a.comentario || "",
    hora_contato: a.horaContato || "",
    tentativas: a.tentativas || [false, false, false, false, false, false, false, false],
    tentativas_datas: a.tentativasDatas || {},
    aberto_em: a.abertoEm || Date.now(),
    encerrado: a.encerrado || false,
    encerrado_em: a.encerradoEm || null,
    agendado_em: a.agendadoEm || "",
    a20: a.a20 || false,
    a10: a.a10 || false,
    a4h: a.a4h || false,
    a_agd: a.aAgd || false,
    a05: a.a05 || false,
  };
  const { error } = await supabase.from("atendimentos").upsert(row, { onConflict: "pipefy_card_id" });
  if (error) console.warn("DB upsert error:", error.message);
};

const upsertMany = async (items: Atendimento[]) => {
  const rows = items.map(a => ({
    pipefy_card_id: a.id,
    lic: a.lic || "",
    cli: a.cli || "",
    cel: a.cel || "",
    clas: a.clas || "NFe",
    dem: a.dem || "Média",
    stat: a.stat || "",
    etapa: a.etapa || "Caixa de entrada",
    analista: a.analista || "",
    comentario: a.comentario || "",
    hora_contato: a.horaContato || "",
    tentativas: a.tentativas || [false, false, false, false, false, false, false, false],
    tentativas_datas: a.tentativasDatas || {},
    aberto_em: a.abertoEm || Date.now(),
    encerrado: a.encerrado || false,
    encerrado_em: a.encerradoEm || null,
    agendado_em: a.agendadoEm || "",
    a20: a.a20 || false,
    a10: a.a10 || false,
    a4h: a.a4h || false,
    a_agd: a.aAgd || false,
    a05: a.a05 || false,
  }));
  const { error } = await supabase.from("atendimentos").upsert(rows, { onConflict: "pipefy_card_id" });
  if (error) console.warn("DB bulk upsert error:", error.message);
};

const dbRowToAtendimento = (r: any): Atendimento => ({
  id: r.pipefy_card_id || r.id,
  lic: r.lic || "",
  cli: r.cli || "",
  cel: r.cel || "",
  clas: r.clas || "NFe",
  dem: r.dem || "Média",
  stat: r.stat || "",
  etapa: r.etapa || "Caixa de entrada",
  analista: r.analista || "",
  comentario: r.comentario || "",
  horaContato: r.hora_contato || "",
  tentativas: r.tentativas || [false, false, false, false, false, false, false, false],
  tentativasDatas: r.tentativas_datas || {},
  abertoEm: r.aberto_em || Date.now(),
  encerrado: r.encerrado || false,
  encerradoEm: r.encerrado_em || null,
  agendadoEm: r.agendado_em || "",
  a20: r.a20 || false,
  a10: r.a10 || false,
  a4h: r.a4h || false,
  aAgd: r.a_agd || false,
  a05: r.a05 || false,
});

const loadFromDB = async (): Promise<Atendimento[]> => {
  const { data, error } = await supabase.from("atendimentos").select("*").order("aberto_em", { ascending: true });
  if (error) { console.warn("DB load error:", error.message); return []; }
  return (data || []).map(dbRowToAtendimento);
};

// ── Field helpers (FIXED: more strict matching) ──
const fieldVal = (card: any, ...keys: string[]) => {
  if (!card) return "";
  const arr = card.fields || [];
  for (const key of keys) {
    const normalizedKey = key.toLowerCase().replace(/[\s:_-]/g, "").trim();
    for (const f of arr) {
      const label = (f.name || "").toLowerCase().replace(/[\s:_-]/g, "").trim();
      // Strict: label must equal key or one must contain the other fully
      if (label === normalizedKey || label === normalizedKey.slice(0, label.length) && label.length >= 8) {
        let v = (f.value || "").trim();
        v = v.replace(/^\["(.+)"\]$/, "$1").replace(/^"(.+)"$/, "$1");
        if (v && v !== "[]") return v;
      }
    }
  }
  return "";
};

const parseDate = (val: string | null | undefined) => {
  if (!val) return null;
  const d = new Date(val);
  if (!isNaN(d.getTime())) return d;
  if (typeof val === "string" && val.includes("/")) {
    const [datePart, timePart] = val.split(" ");
    const [day, month, year] = datePart.split("/");
    const iso = `${year}-${month}-${day}${timePart ? "T" + timePart : ""}`;
    const d2 = new Date(iso);
    if (!isNaN(d2.getTime())) return d2;
  }
  return null;
};

const getAnalista = (card: any) => {
  if (!card) return "";
  let name = "";
  if (card.assignees?.length) name = card.assignees[0]?.name || card.assignees[0];
  else {
    const novo = fieldVal(card, "ANALISTA SELECIONADO (NOVO)");
    if (novo) name = novo;
    else {
      const sel = fieldVal(card, "ANALISTA SELECIONADO");
      if (sel) name = sel;
      else {
        const nom = fieldVal(card, "Nome do analista");
        if (nom && !["cliente", "CLIENTE"].includes(nom)) name = nom;
      }
    }
  }
  return typeof name === "string" ? name.toUpperCase() : "";
};

const p2 = (n: number) => String(n).padStart(2, "0");
const fmt = (ms: number) => {
  if (ms < 0) return "00:00:00";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${p2(h % 24)}:${p2(m)}:${p2(s)}`; }
  return `${p2(h)}:${p2(m)}:${p2(s)}`;
};
const fmtM = (ms: number) => {
  if (!ms || isNaN(ms)) return "—";
  if (ms <= 0) return "Vencido!";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
  return h > 0 ? `${h}h ${p2(m)}m` : `${m}m`;
};

const PIPE_QUERY = `
  query FetchPipe($id: ID!) {
    pipe(id: $id) {
      id name
      phases { id name done cards(first: 50) { edges { node { id title createdAt current_phase { name } assignees { id name } fields { name value datetime_value } } } } }
      labels { id name }
      start_form_fields { id label options }
    }
  }
`;

// Query to fetch subcategories from the pipe fields
const SUBCATEGORIES_QUERY = `
  query FetchPipeFields($id: ID!) {
    pipe(id: $id) {
      phases {
        fields {
          id label type options
        }
      }
      start_form_fields { id label type options }
    }
  }
`;

export default function Index() {
  const [data, setData] = useState<Atendimento[]>([]);
  const [now, setNow] = useState(new Date());
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [phaseIds, setPhaseIds] = useState<Record<string, string>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seenCards = useRef(new Set<string>());
  const slackSent = useRef(new Set<string>());
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem("cat_dark");
    return saved === "true";
  });

  const [activeTab, setActiveTab] = useState<"list" | "dashboard" | "email">("list");

  const [busca, setBusca] = useState("");
  const [fClas, setFClas] = useState("");
  const [fDem, setFDem] = useState("");
  const [fAnalista, setFAnalista] = useState(() => localStorage.getItem("cat_fAnalista") || "BRUNO");

  // Subcategorias from Pipefy
  const [subcategorias, setSubcategorias] = useState<string[]>([]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem("cat_dark", String(darkMode));
  }, [darkMode]);

  const [alerta, setAlerta] = useState<{ tipo: string; titulo: string; cli: string; msg: string } | null>(null);
  const [modEdit, setModEdit] = useState<Atendimento | null>(null);
  const [coment, setComent] = useState<{ id: string; text: string } | null>(null);

  const [novo, setNovo] = useState({ lic: "", cli: "", cel: "", horaContato: "", clas: "NFe", dem: "Alta", stat: "Normal" });
  const fLicRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") Notification.requestPermission();
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const toast = (msg: string, time = 3000) => { setToastMsg(msg); setTimeout(() => setToastMsg(null), time); };

  const audioCtxRef = useRef<AudioContext | null>(null);
  const beep = (freq: number, dur: number) => {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.3, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      o.start(); o.stop(ctx.currentTime + dur);
    } catch {}
  };

  // ── Fetch subcategories from Pipefy ──
  const fetchSubcategorias = useCallback(async () => {
    try {
      const resp = await pipefyQuery(SUBCATEGORIES_QUERY, { id: PIPE_ID });
      const pipe = resp?.pipe;
      if (!pipe) return;

      const allOptions: string[] = [];
      const categoryKeywords = ["subcategor", "categoria", "configura", "instala", "erro", "atualiza", "reconfigura", "duvida"];

      // Search all phase fields for subcategory options
      (pipe.phases || []).forEach((ph: any) => {
        (ph.fields || []).forEach((f: any) => {
          const label = (f.label || "").toLowerCase();
          const isSubcategory = categoryKeywords.some(kw => label.includes(kw));
          if (isSubcategory && f.options && Array.isArray(f.options)) {
            f.options.forEach((opt: string) => {
              if (opt && !allOptions.includes(opt)) allOptions.push(opt);
            });
          }
        });
      });

      // Also check start form fields
      (pipe.start_form_fields || []).forEach((f: any) => {
        const label = (f.label || "").toLowerCase();
        const isSubcategory = categoryKeywords.some(kw => label.includes(kw));
        if (isSubcategory && f.options && Array.isArray(f.options)) {
          f.options.forEach((opt: string) => {
            if (opt && !allOptions.includes(opt)) allOptions.push(opt);
          });
        }
      });

      if (allOptions.length > 0) {
        setSubcategorias(allOptions);
      }
    } catch (e) {
      console.warn("Failed to fetch subcategories:", e);
    }
  }, []);

  // ── Load from DB on mount ──
  useEffect(() => {
    loadFromDB().then(rows => {
      if (rows.length > 0) setData(rows);
      fetchData(false);
    });
    fetchSubcategorias();
  }, []);

  // ── Send comment to Pipefy ──
  const sendPipefyComment = useCallback(async (cardId: string, message: string) => {
    try {
      await pipefyQuery(`mutation { createComment(input: { card_id: ${cardId}, text: "${message.replace(/"/g, '\\"')}" }) { comment { id } } }`);
      toast("Mensagem enviada ao Pipefy!");
    } catch (e: any) {
      toast(`Erro ao enviar mensagem: ${e.message}`);
    }
  }, []);

  // ── Generate closure message with AI ──
  const generateClosureMessage = useCallback(async (a: Atendimento) => {
    try {
      const { data: aiData, error: aiError } = await supabase.functions.invoke("openrouter-proxy", {
        body: {
          action: "summarize_closure",
          context: {
            cliente: a.cli,
            classificacao: a.clas,
            subcategoria: a.clas,
            comentarios: a.comentario || "Sem comentarios",
            etapas: a.etapa,
          },
        },
      });

      if (aiError) throw new Error(aiError.message);
      const message = aiData?.message || "Atendimento concluido com sucesso.";

      // Send to Pipefy as comment
      await sendPipefyComment(a.id, message);

      // Save to local
      return message;
    } catch (e: any) {
      console.warn("AI closure failed:", e);
      return "Atendimento finalizado com sucesso.";
    }
  }, [sendPipefyComment]);

  // ── Sync with Pipefy ──
  const fetchData = useCallback(async (silent = false) => {
    try {
      const resp = await pipefyQuery(PIPE_QUERY, { id: PIPE_ID });
      if (!resp?.pipe) throw new Error("Resposta invalida do Pipefy");
      const pipe = resp.pipe;
      const flat: Atendimento[] = [];
      const pIds: Record<string, string> = {};

      (pipe.phases || []).forEach((ph: any) => {
        if (!ph) return;
        pIds[ph.name] = ph.id;
        const isEncerrado = !!ph.done || Array.from(DONE_PHASES).some(d => d.toLowerCase() === (ph.name || "").toLowerCase());
        (ph.cards?.edges || []).forEach(({ node: c }: any) => {
          // FIXED: Get client data directly from Pipefy fields with strict matching
          const lic = fieldVal(c, "Codigo da Licenca", "licenca") || c.title?.split(" - ")[0]?.trim() || c.id.slice(-6).toUpperCase();
          const cli = fieldVal(c, "Nome do Cliente", "nome do cliente") || c.title?.trim() || "";
          const cel = fieldVal(c, "Telefone Cliente", "telefone do cliente", "telefone")?.replace("+55", "").trim() || "";

          // Get subcategory from Pipefy if available
          let clas = fieldVal(c, "SUBCATEGORIA", "SUBCATEGORIA CHAMADO");
          if (!clas) {
            clas = fieldVal(c, "CATEGORIA - CONFIGURACAO", "CATEGORIA - ERRO", "CATEGORIA CHAMADO", "CATEGORIA");
          }
          const foundClas = Object.keys(CHEX).find(k => clas.toLowerCase().includes(k.toLowerCase()));
          if (foundClas) clas = foundClas;
          else if (!clas || clas === "[]") clas = "NFe";

          const dem = fieldVal(c, "Prioridade").toLowerCase().includes("alta") ? "Alta" : "Media";
          const dtVal = c.createdAt;
          const fields = c.fields || [];
          const fHora = fields.find((f: any) => f.name?.toLowerCase().includes("primeiro contato"));
          const parsedDate = parseDate(dtVal) || parseDate(fHora?.datetime_value) || parseDate(fHora?.value) || new Date();
          const openedAt = parsedDate.getTime();

          const agendField = fields.find((f: any) => {
            const n = (f.name || "").toLowerCase();
            return n.includes("agendad") || n.includes("reagendad") || n.includes("data do agendamento") || n.includes("horario");
          });
          const agendadoEm = agendField?.datetime_value || agendField?.value || "";

          flat.push({
            id: c.id, lic, cli, cel,
            clas, dem, stat: fieldVal(c, "Situacao", "Status") || "Normal",
            etapa: c.current_phase?.name || "Caixa de entrada",
            tentativas: [false, false, false, false, false, false, false, false], abertoEm: openedAt,
            encerrado: isEncerrado, encerradoEm: isEncerrado ? Date.now() : null,
            horaContato: fHora?.value || "", analista: (getAnalista(c) || "").toUpperCase(),
            comentario: "", a20: false, a10: false, a4h: false, aAgd: false, a05: false,
            agendadoEm, tentativasDatas: {}, _original: c,
          });
        });
      });

      setPhaseIds(pIds);

      // Notify new cards + Slack
      flat.forEach(c => {
        const isAnSel = (c.etapa || "").toLowerCase().includes("analista selecionado");
        if (isAnSel && c.analista && !seenCards.current.has(c.id)) {
          seenCards.current.add(c.id);
          slackNotify({ type: "novo_atendimento", analista: c.analista, cliente: c.cli, licenca: c.lic });
          const isMe = !fAnalista || c.analista === fAnalista;
          if (isMe) {
            setAlerta({ tipo: "aviso", titulo: "NOVO ATENDIMENTO!", cli: c.cli.toUpperCase(), msg: `LICENCA: ${c.lic}\nNOVO CARD EM ANALISTA SELECIONADO.` });
            beep(500, 1.2);
          }
        }
      });

      setData(prev => {
        const idMap = new Map((prev || []).map(i => [i.id, i]));
        const merged = flat.map(sc => {
          const local = idMap.get(sc.id);
          if (local) {
            const nt = Array.isArray(local.tentativas) ? [...local.tentativas] : [false, false, false, false, false, false, false, false];
            while (nt.length < 8) nt.push(false);
            // FIXED: Always use Pipefy data for cli, cel, lic (not local overrides)
            return {
              ...sc,
              tentativas: nt,
              tentativasDatas: local.tentativasDatas || {},
              stat: local.stat || "Normal",
              comentario: local.comentario || sc.comentario,
              a05: local.a05, a20: local.a20, a4h: local.a4h, aAgd: local.aAgd,
              agendadoEm: sc.agendadoEm || local.agendadoEm,
              horaContato: local.horaContato || sc.horaContato,
            };
          }
          return sc;
        });
        // Persist to DB
        upsertMany(merged);
        return merged;
      });
      setLastSync(new Date());
      if (!silent) toast("Pipefy sincronizado!");
    } catch (e: any) {
      if (!silent) toast(`Erro Pipefy: ${e.message}`);
    }
  }, [fAnalista]);

  useEffect(() => {
    pollRef.current = setInterval(() => fetchData(true), POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchData]);

  // Alert worker + Slack SLA alerts (using business hours)
  useEffect(() => {
    let alertToSet: any = null;
    setData(prev => {
      if (!Array.isArray(prev)) return [];
      let changed = false;
      const n = [...prev];
      const nowTs = now.getTime();
      n.filter(a => a && !a.encerrado).forEach(a => {
        const el = calcBusinessElapsed(a.abertoEm || 0, nowTs);
        const rest = LIM - el;
        const isMe = !fAnalista || a.analista === fAnalista;
        const isAnSel = (a.etapa || "").toLowerCase().includes("analista selecionado");
        if (isAnSel) {
          if (rest <= AV20 && rest > AV05 && !a.a20) {
            a.a20 = true; changed = true;
            const key = `20_${a.id}`;
            if (!slackSent.current.has(key)) {
              slackSent.current.add(key);
              slackNotify({ type: "alerta_20min", analista: a.analista, cliente: a.cli, licenca: a.lic, minutos: Math.ceil(rest / 60000) });
            }
            if (isMe) alertToSet = { tipo: "urgente", titulo: "ATENCAO — PRAZO!", cli: a.cli.toUpperCase(), msg: `FALTAM ${Math.ceil(rest / 60000)} MINUTOS PARA O PRAZO DE 4H.` };
          }
          if (rest <= AV05 && rest > 0 && !a.a05) {
            a.a05 = true; changed = true;
            const key = `05_${a.id}`;
            if (!slackSent.current.has(key)) {
              slackSent.current.add(key);
              slackNotify({ type: "alerta_5min", analista: a.analista, cliente: a.cli, licenca: a.lic, minutos: Math.ceil(rest / 60000) });
            }
            if (isMe) alertToSet = { tipo: "urgente", titulo: "PRAZO CRITICO!", cli: a.cli.toUpperCase(), msg: `APENAS ${Math.ceil(rest / 60000)} MINUTOS RESTANTES!` };
          }
          if (rest <= 0 && !a.a4h) {
            a.a4h = true; changed = true;
            const key = `4h_${a.id}`;
            if (!slackSent.current.has(key)) {
              slackSent.current.add(key);
              slackNotify({ type: "prazo_vencido", analista: a.analista, cliente: a.cli, licenca: a.lic });
            }
            if (isMe) alertToSet = { tipo: "urgente", titulo: "PRAZO VENCIDO!", cli: a.cli.toUpperCase(), msg: "PRAZO DE 4H VENCIDO! RESOLVA IMEDIATAMENTE." };
          }
        }

        // Agendados: alert 5 min before
        const isAgendado = (a.etapa || "").toLowerCase().includes("agendado");
        if (isAgendado && a.horaContato && !a.aAgd) {
          const agd = parseDate(a.horaContato);
          if (agd) {
            const diff = agd.getTime() - nowTs;
            if (diff <= 5 * 60000 && diff > 0) {
              a.aAgd = true; changed = true;
              const key = `agd_${a.id}`;
              if (!slackSent.current.has(key)) {
                slackSent.current.add(key);
                slackNotify({ type: "agendado_5min", analista: a.analista, cliente: a.cli, licenca: a.lic, horaAgendada: agd.toLocaleTimeString("pt-BR") });
              }
              if (isMe) alertToSet = { tipo: "urgente", titulo: "AGENDAMENTO EM 5 MIN!", cli: a.cli.toUpperCase(), msg: `Horario agendado: ${agd.toLocaleTimeString("pt-BR")}` };
            }
          }
        }
      });
      if (changed) {
        const changedItems = n.filter(a => a && !a.encerrado);
        upsertMany(changedItems);
      }
      return changed ? n : prev;
    });
    if (alertToSet) { setAlerta(alertToSet); beep(700, 0.8); }
  }, [now, fAnalista]);

  // ── Realtime subscription ──
  useEffect(() => {
    const channel = supabase
      .channel("atendimentos_realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "atendimentos" }, (payload) => {
        if (payload.eventType === "UPDATE" || payload.eventType === "INSERT") {
          const row = payload.new;
          const updated = dbRowToAtendimento(row);
          setData(prev => {
            const idx = prev.findIndex(a => a.id === updated.id);
            if (idx >= 0) {
              const n = [...prev];
              n[idx] = { ...n[idx], ...updated, _original: n[idx]._original };
              return n;
            }
            return [updated, ...prev];
          });
        }
        if (payload.eventType === "DELETE") {
          const row = payload.old as any;
          setData(prev => prev.filter(a => a.id !== (row.pipefy_card_id || row.id)));
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  // ── Actions ──
  const updateCard = async (id: string, changes: Partial<Atendimento>) => {
    // Check if finalizing + closing → generate AI message
    const isFinalizing = (changes.etapa === "Finalizado" || changes.etapa === "Finalizado em" || changes.etapa === "Concluido")
      && changes.encerrado === true;

    if (isFinalizing) {
      const card = data.find(c => c.id === id);
      if (card) {
        const closureMsg = await generateClosureMessage(card);
        changes.comentario = closureMsg;
      }
    }

    setData(p => {
      const n = p.map(c => c.id === id ? { ...c, ...changes } : c);
      const updated = n.find(c => c.id === id);
      if (updated) upsertAtendimento(updated);
      return n;
    });

    if (changes.etapa && phaseIds[changes.etapa]) {
      try {
        await pipefyQuery(`mutation { moveCardToPhase(input: { card_id: "${id}", destination_phase_id: "${phaseIds[changes.etapa]}" }) { card { id } } }`);

        // If moving to "Hora primeiro contato", send the contact message and update hora field in Pipefy
        if (changes.etapa.toLowerCase().includes("hora primeiro contato")) {
          const card = data.find(c => c.id === id);
          if (card) {
            const horaAgora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
            const msg = `Primeira tentativa de contato\n\nNome do cliente: ${card.cli}\nCelular: ${card.cel}\nHora: ${horaAgora}\nAnalista: ${card.analista || fAnalista}`;
            await sendPipefyComment(id, msg);

            // Try to update the hora field in Pipefy
            try {
              const fields = (card._original as any)?.fields || [];
              const horaField = fields.find((f: any) => f.name?.toLowerCase().includes("primeiro contato"));
              if (horaField) {
                // Update the field value
                await pipefyQuery(`mutation { updateCardField(input: { card_id: ${id}, field_id: "${horaField.name}", new_value: "${horaAgora}" }) { card { id } } }`);
              }
            } catch (e) {
              console.warn("Failed to update hora field:", e);
            }
          }
        }
      } catch (e: any) {
        toast(`Erro: ${e.message}`);
      }
    }
  };

  const tent = (id: string, i: number) => {
    const a = data.find(x => x.id === id);
    if (!a || a.encerrado) return;
    const nt = [...a.tentativas];
    nt[i] = !nt[i];
    const newDatas = { ...(a.tentativasDatas || {}) };
    if (nt[i]) {
      newDatas[String(i)] = new Date().toISOString();
    } else {
      delete newDatas[String(i)];
    }
    if (i === 2 && nt[2]) toast("3a tentativa! Considere encerrar.");
    updateCard(id, { tentativas: nt, tentativasDatas: newDatas });
  };

  const addAt = async () => {
    if (!novo.lic || !novo.cli) { toast("Preencha Licenca e Cliente"); return; }
    const id = Date.now().toString();
    const newItem: Atendimento = {
      id, ...novo, etapa: ETAPAS[0], tentativas: [false, false, false, false, false, false, false, false],
      abertoEm: Date.now(), encerrado: false, encerradoEm: null, horaContato: novo.horaContato,
      analista: fAnalista || "", comentario: "", a20: false, a10: false, a4h: false, aAgd: false, a05: false, agendadoEm: "",
      tentativasDatas: {},
    };
    setData(p => [newItem, ...p]);
    await upsertAtendimento(newItem);
    setNovo({ lic: "", cli: "", cel: "", horaContato: "", clas: "NFe", dem: "Alta", stat: "Normal" });
    toast("Atendimento criado!");
  };

  const copyContactMsg = (a: Atendimento) => {
    // FIXED: Use data from the Pipefy card directly
    const text = `Primeira tentativa de contato\n\nNome do cliente: ${a.cli}\nCelular: ${a.cel}\nHora: ${now.toLocaleTimeString()}\nAnalista: ${a.analista || fAnalista}`;
    navigator.clipboard.writeText(text);
    toast("Mensagem copiada!");
  };

  const limEnc = async () => {
    const encerrados = data.filter(x => x.encerrado);
    for (const e of encerrados) {
      await supabase.from("atendimentos").delete().eq("pipefy_card_id", e.id);
    }
    setData(p => p.filter(x => !x.encerrado));
    toast("Encerrados removidos");
  };

  // ── Derived ──
  const analistasList = useMemo(() => {
    const s = new Set(data.map(a => a?.analista).filter(Boolean));
    return Array.from(s).sort();
  }, [data]);

  const filtered = useMemo(() => {
    const b = busca.toLowerCase();
    return data.filter(a => {
      if (!a) return false;
      const isAgendado = (a.etapa || "").toLowerCase().includes("agendado");
      const mb = !b || a.cli.toLowerCase().includes(b) || a.lic.toLowerCase().includes(b);
      const mc = !fClas || a.clas === fClas;
      const md = !fDem || a.dem === fDem;
      const ma = !fAnalista || a.analista === fAnalista;
      return mb && mc && md && ma && !a.encerrado && !isAgendado;
    }).sort((a, b) => (a.abertoEm || 0) - (b.abertoEm || 0));
  }, [data, busca, fClas, fDem, fAnalista]);

  const agendados = useMemo(() => {
    return data.filter(a => {
      if (!a || a.encerrado) return false;
      const isAgendado = (a.etapa || "").toLowerCase().includes("agendado");
      const ma = !fAnalista || a.analista === fAnalista;
      return isAgendado && ma;
    }).sort((a, b) => {
      const da = parseDate(a.horaContato)?.getTime() || 0;
      const db = parseDate(b.horaContato)?.getTime() || 0;
      return da - db;
    });
  }, [data, fAnalista]);

  const memData = useMemo(() => fAnalista ? data.filter(a => a?.analista === fAnalista) : data, [data, fAnalista]);
  const abrt = memData.filter(a => a && !a.encerrado).length;
  const alta = memData.filter(a => a && !a.encerrado && a.dem === "Alta").length;
  const aVencer = memData.filter(a => a && !a.encerrado && (a.etapa || "").toLowerCase().includes("analista selecionado")).sort((a, b) => (a.abertoEm || 0) - (b.abertoEm || 0)).slice(0, 5);

  return (
    <div className="min-h-screen bg-background p-4 md:p-6 max-w-7xl mx-auto">
      {/* Topbar */}
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-lg">C</div>
          <div>
            <h1 className="text-lg font-bold text-foreground tracking-tight">Central de Atendimentos</h1>
            <p className="text-xs text-muted-foreground">Gestao de chamados em tempo real</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={fAnalista}
            onChange={e => { setFAnalista(e.target.value); localStorage.setItem("cat_fAnalista", e.target.value); }}
            className="text-sm bg-card border border-border rounded-lg px-3 py-1.5 text-foreground outline-none focus:border-primary"
          >
            <option value="">Todos</option>
            {analistasList.map(an => <option key={an} value={an}>{an}</option>)}
          </select>
          <button onClick={() => setDarkMode(!darkMode)} className="text-sm border border-border rounded-lg px-3 py-1.5 text-foreground hover:bg-muted transition-colors" title="Alternar tema">
            {darkMode ? "Claro" : "Escuro"}
          </button>
          <button onClick={() => fetchData()} className="text-sm border border-border rounded-lg px-3 py-1.5 text-foreground hover:bg-muted transition-colors">Sync</button>
          <div className="font-mono text-sm font-semibold text-primary bg-card border border-border rounded-lg px-3 py-1.5 flex items-center gap-2">
            {now.toLocaleTimeString("pt-BR")}
            <div className="w-2 h-2 rounded-full bg-vintage-green animate-pulse" />
          </div>
        </div>
      </header>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-primary rounded-xl p-4 text-primary-foreground">
          <div className="text-[0.65rem] uppercase font-bold opacity-80">Aguardando</div>
          <div className="text-2xl font-extrabold">{abrt}</div>
          <div className="text-[0.7rem] opacity-70">Chamados abertos</div>
        </div>
        <div className="bg-card rounded-xl p-4 border border-border">
          <div className="text-[0.65rem] uppercase font-bold text-muted-foreground">Alta Demanda</div>
          <div className="text-2xl font-extrabold text-destructive">{alta}</div>
          <div className="text-[0.7rem] text-muted-foreground">Prioridade maxima</div>
        </div>
        <div className="bg-card rounded-xl p-4 border border-border">
          <div className="text-[0.65rem] uppercase font-bold text-muted-foreground">Agendados</div>
          <div className="text-2xl font-extrabold text-vintage-yellow">{agendados.length}</div>
          <div className="text-[0.7rem] text-muted-foreground">Clientes agendados</div>
        </div>
        <div className="bg-card rounded-xl p-4 border border-border">
          <div className="text-[0.65rem] uppercase font-bold text-accent mb-1">Proximos a Vencer</div>
          {aVencer.slice(0, 3).map(t => {
            const rest = calcBusinessRemaining(t.abertoEm || 0, now.getTime(), LIM);
            return (
              <div key={t.id} className="flex justify-between text-xs py-0.5">
                <span className="truncate max-w-[100px] font-medium">{t.lic} | {t.cli.slice(0, 8)}</span>
                <span className={`font-mono font-bold ${rest < 0 ? "text-destructive" : "text-accent"}`}>{fmtM(rest)}</span>
              </div>
            );
          })}
          {aVencer.length === 0 && <div className="text-xs text-muted-foreground mt-1">Nenhum no prazo.</div>}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-muted rounded-lg p-1 w-fit">
        <button
          onClick={() => setActiveTab("list")}
          className={`text-sm font-semibold px-4 py-1.5 rounded-md transition-colors ${activeTab === "list" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >Atendimentos</button>
        <button
          onClick={() => setActiveTab("dashboard")}
          className={`text-sm font-semibold px-4 py-1.5 rounded-md transition-colors ${activeTab === "dashboard" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >Dashboard</button>
        <button
          onClick={() => setActiveTab("email")}
          className={`text-sm font-semibold px-4 py-1.5 rounded-md transition-colors ${activeTab === "email" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
        >Email</button>
      </div>

      {activeTab === "dashboard" ? (
        <Dashboard data={data} now={now} />
      ) : activeTab === "email" ? (
        <GmailPanel />
      ) : (
      <>
      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <input
          type="text"
          placeholder="Buscar licenca ou cliente..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
          className="text-sm bg-card border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary min-w-[200px] flex-1 md:flex-none"
        />
        <select value={fClas} onChange={e => setFClas(e.target.value)} className="text-sm bg-card border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary">
          <option value="">Todas class.</option>
          {subcategorias.length > 0
            ? subcategorias.map(c => <option key={c} value={c}>{c}</option>)
            : Object.keys(CHEX).map(c => <option key={c}>{c}</option>)
          }
        </select>
        <select value={fDem} onChange={e => setFDem(e.target.value)} className="text-sm bg-card border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary">
          <option value="">Toda demanda</option>
          <option value="Alta">Alta</option>
          <option value="Media">Media</option>
        </select>
        <button onClick={limEnc} className="text-sm text-destructive bg-destructive/10 border border-transparent rounded-lg px-3 py-2 font-semibold hover:bg-destructive/20 transition-colors">Limpar enc.</button>
        <div className="ml-auto text-xs text-muted-foreground font-medium">
          {filtered.length} registro(s) {lastSync && `| Sync: ${lastSync.toLocaleTimeString("pt-BR")}`}
        </div>
      </div>

      {/* Attendance list */}
      <div className="space-y-1 mb-8">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">Nenhum atendimento encontrado.</div>
        ) : (
          filtered.map((a, i) => (
            <AttendanceCard
              key={a.id}
              item={a}
              index={i}
              now={now}
              onUpdateCard={updateCard}
              onComment={(id, text) => setComent({ id, text })}
              onEdit={item => setModEdit({ ...item })}
              onCopyMsg={copyContactMsg}
              onToggleTent={tent}
              onSendPipefyComment={sendPipefyComment}
              fAnalista={fAnalista}
              subcategorias={subcategorias}
            />
          ))
        )}
      </div>

      {/* Agendados Section */}
      {agendados.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-base font-bold text-foreground">Agendados</h2>
            <span className="text-xs bg-vintage-yellow/20 text-vintage-yellow font-bold px-2 py-0.5 rounded-full">{agendados.length}</span>
          </div>
          <div className="space-y-1.5">
            {agendados.map((a, i) => (
              <AttendanceCard
                key={a.id}
                item={a}
                index={i}
                now={now}
                onUpdateCard={updateCard}
                onComment={(id, text) => setComent({ id, text })}
                onEdit={item => setModEdit({ ...item })}
                onCopyMsg={copyContactMsg}
                onToggleTent={tent}
                onSendPipefyComment={sendPipefyComment}
                fAnalista={fAnalista}
                subcategorias={subcategorias}
              />
            ))}
          </div>
        </div>
      )}

      {/* New attendance form */}
      <div className="bg-card border border-border rounded-xl p-5 mb-6">
        <div className="text-sm font-bold text-accent mb-3">Novo Atendimento</div>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Licenca</label>
            <input ref={fLicRef} type="text" placeholder="12345" value={novo.lic} onChange={e => setNovo({ ...novo, lic: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 w-24 text-foreground outline-none focus:border-primary" />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
            <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Cliente</label>
            <input type="text" placeholder="Nome" value={novo.cli} onChange={e => setNovo({ ...novo, cli: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Celular</label>
            <input type="text" placeholder="(99) 99999-9999" value={novo.cel} onChange={e => setNovo({ ...novo, cel: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 w-36 text-foreground outline-none focus:border-primary" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Class.</label>
            <select value={novo.clas} onChange={e => setNovo({ ...novo, clas: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-2 py-2 text-foreground outline-none focus:border-primary">
              {subcategorias.length > 0
                ? subcategorias.map(c => <option key={c}>{c}</option>)
                : Object.keys(CHEX).map(c => <option key={c}>{c}</option>)
              }
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Demanda</label>
            <select value={novo.dem} onChange={e => setNovo({ ...novo, dem: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-2 py-2 text-foreground outline-none focus:border-primary">
              <option value="Alta">Alta</option>
              <option value="Media">Media</option>
            </select>
          </div>
          <button onClick={addAt} className="bg-primary text-primary-foreground text-sm font-bold rounded-lg px-4 py-2 hover:opacity-90 transition-opacity">Adicionar</button>
        </div>
      </div>
      </>
      )}

      {/* Toast */}
      <div id="toast-custom" className={toastMsg ? "show" : ""}>{toastMsg}</div>

      {/* Alert Modal */}
      {alerta && (
        <div className="modal-overlay" onClick={() => setAlerta(null)}>
          <div className="bg-card rounded-2xl p-8 max-w-md w-[90%] text-center border border-border shadow-medium animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="text-4xl mb-3">{alerta.tipo === "urgente" ? "!" : "?"}</div>
            <div className="text-lg font-extrabold text-foreground mb-1">{alerta.titulo}</div>
            <div className="text-sm font-semibold text-accent mb-2">{alerta.cli}</div>
            <div className="text-sm text-muted-foreground mb-6 whitespace-pre-line">{alerta.msg}</div>
            <button onClick={() => setAlerta(null)} className="bg-primary text-primary-foreground w-full py-2.5 rounded-lg font-bold text-sm hover:opacity-90 transition-opacity">Entendido</button>
          </div>
        </div>
      )}

      {/* Comment Modal */}
      {coment && (
        <div className="modal-overlay" onClick={() => setComent(null)}>
          <div className="bg-card rounded-2xl p-6 max-w-md w-[90%] border border-border shadow-medium animate-fade-in" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-accent mb-3">Comentario</h3>
            <textarea
              value={coment.text}
              onChange={e => setComent({ ...coment, text: e.target.value })}
              className="w-full h-28 p-3 rounded-lg border border-border bg-muted text-foreground text-sm outline-none focus:border-primary resize-none"
              placeholder="Escreva algo..."
            />
            <div className="flex gap-2 justify-end mt-3">
              <button onClick={() => setComent(null)} className="text-sm px-4 py-2 rounded-lg border border-border text-foreground hover:bg-muted transition-colors">Cancelar</button>
              <button onClick={() => { updateCard(coment.id, { comentario: coment.text }); setComent(null); toast("Comentario salvo!"); }} className="text-sm px-4 py-2 rounded-lg bg-primary text-primary-foreground font-bold hover:opacity-90 transition-opacity">Salvar</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {modEdit && (
        <div className="modal-overlay" onClick={() => setModEdit(null)}>
          <div className="bg-card rounded-2xl p-6 max-w-lg w-[90%] border border-border shadow-medium animate-fade-in" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-accent mb-4">Editar Atendimento</h3>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="flex flex-col gap-1">
                <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Licenca</label>
                <input value={modEdit.lic} onChange={e => setModEdit({ ...modEdit, lic: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Cliente</label>
                <input value={modEdit.cli} onChange={e => setModEdit({ ...modEdit, cli: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Celular</label>
                <input value={modEdit.cel} onChange={e => setModEdit({ ...modEdit, cel: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Classificacao</label>
                <select value={modEdit.clas} onChange={e => setModEdit({ ...modEdit, clas: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary">
                  {subcategorias.length > 0
                    ? subcategorias.map(c => <option key={c}>{c}</option>)
                    : Object.keys(CHEX).map(c => <option key={c}>{c}</option>)
                  }
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Demanda</label>
                <select value={modEdit.dem} onChange={e => setModEdit({ ...modEdit, dem: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary">
                  <option value="Alta">Alta</option>
                  <option value="Media">Media</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Analista</label>
                <input value={modEdit.analista} onChange={e => setModEdit({ ...modEdit, analista: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary" />
              </div>
            </div>
            <div className="flex gap-2 justify-end border-t border-border pt-3">
              <button onClick={() => setModEdit(null)} className="text-sm px-4 py-2 rounded-lg border border-border text-foreground hover:bg-muted transition-colors">Cancelar</button>
              <button onClick={() => { updateCard(modEdit.id, { ...modEdit }); setModEdit(null); toast("Atualizado!"); }} className="text-sm px-4 py-2 rounded-lg bg-primary text-primary-foreground font-bold hover:opacity-90 transition-opacity">Salvar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
