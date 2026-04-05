import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import AttendanceCard, { type Atendimento } from "@/components/AttendanceCard";
import Dashboard from "@/components/Dashboard";

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
    // Somente envia notificações do Slack para o BRUNO
    const analista = String(payload.analista || "").toUpperCase();
    if (analista !== "BRUNO") return;
    await supabase.functions.invoke("slack-notify", { body: payload });
  } catch (e) {
    console.warn("Slack notify failed:", e);
  }
};

// ── Field helpers ──
const fieldVal = (card: any, ...keys: string[]) => {
  if (!card) return "";
  const arr = card.fields || [];
  for (const key of keys) {
    const k = key.toLowerCase().replace(/[:\s]/g, "");
    for (const f of arr) {
      const label = (f.name || "").toLowerCase().replace(/[:\s]/g, "");
      if (label === k || label.includes(k) || k.includes(label.slice(0, Math.min(label.length, 15)))) {
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

  const [activeTab, setActiveTab] = useState<"list" | "dashboard">("list");

  const [busca, setBusca] = useState("");
  const [fClas, setFClas] = useState("");
  const [fDem, setFDem] = useState("");
  const [fAnalista, setFAnalista] = useState(() => localStorage.getItem("cat_fAnalista") || "BRUNO");

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

  // ── Sync with Pipefy ──
  const fetchData = useCallback(async (silent = false) => {
    try {
      const resp = await pipefyQuery(PIPE_QUERY, { id: PIPE_ID });
      if (!resp?.pipe) throw new Error("Resposta inválida do Pipefy");
      const pipe = resp.pipe;
      const flat: Atendimento[] = [];
      const pIds: Record<string, string> = {};

      (pipe.phases || []).forEach((ph: any) => {
        if (!ph) return;
        pIds[ph.name] = ph.id;
        const isEncerrado = !!ph.done || Array.from(DONE_PHASES).some(d => d.toLowerCase() === (ph.name || "").toLowerCase());
        (ph.cards?.edges || []).forEach(({ node: c }: any) => {
          const lic = fieldVal(c, "Código da Licença", "licenca") || c.title?.split(" - ")[0]?.trim() || c.id.slice(-6).toUpperCase();
          const cli = fieldVal(c, "Nome do Cliente", "nome") || c.title?.trim() || "";
          let clas = fieldVal(c, "CATEGORIA - CONFIGURAÇÃO", "CATEGORIA - ERRO", "CATEGORIA CHAMADO", "CATEGORIA");
          const foundClas = Object.keys(CHEX).find(k => clas.toLowerCase().includes(k.toLowerCase()));
          if (foundClas) clas = foundClas;
          else if (!clas || !Object.keys(CHEX).includes(clas)) clas = "NFe";
          const dem = fieldVal(c, "Prioridade").toLowerCase().includes("alta") ? "Alta" : "Média";
          const dtVal = c.createdAt;
          const fields = c.fields || [];
          const fHora = fields.find((f: any) => f.name?.toLowerCase().includes("primeiro contato"));
          const parsedDate = parseDate(dtVal) || parseDate(fHora?.datetime_value) || parseDate(fHora?.value) || new Date();
          const openedAt = parsedDate.getTime();

          // Parse agendamento date
          const agendField = fields.find((f: any) => {
            const n = (f.name || "").toLowerCase();
            return n.includes("agendad") || n.includes("reagendad") || n.includes("data do agendamento") || n.includes("horário");
          });
          const agendadoEm = agendField?.datetime_value || agendField?.value || "";

          flat.push({
            id: c.id, lic, cli, cel: fieldVal(c, "Telefone Cliente", "telefone")?.replace("+55", "").trim() || "",
            clas, dem, stat: fieldVal(c, "Situação", "Status") || "Normal",
            etapa: c.current_phase?.name || "Caixa de entrada",
            tentativas: [false, false, false, false, false, false, false, false], abertoEm: openedAt,
            encerrado: isEncerrado, encerradoEm: isEncerrado ? Date.now() : null,
            horaContato: fHora?.value || "", analista: (getAnalista(c) || "").toUpperCase(),
            comentario: "", a20: false, a10: false, a4h: false, aAgd: false, a05: false,
            agendadoEm, _original: c,
          });
        });
      });

      setPhaseIds(pIds);

      // Notify new cards + Slack
      flat.forEach(c => {
        const isAnSel = (c.etapa || "").toLowerCase().includes("analista selecionado");
        if (isAnSel && c.analista && !seenCards.current.has(c.id)) {
          seenCards.current.add(c.id);
          // Send Slack notification for new assignment
          slackNotify({ type: "novo_atendimento", analista: c.analista, cliente: c.cli, licenca: c.lic });
          const isMe = !fAnalista || c.analista === fAnalista;
          if (isMe) {
            setAlerta({ tipo: "aviso", titulo: "🎯 NOVO ATENDIMENTO!", cli: c.cli.toUpperCase(), msg: `LICENÇA: ${c.lic}\nNOVO CARD EM ANALISTA SELECIONADO.` });
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
            return { ...sc, tentativas: nt, stat: local.stat || "Normal", a05: local.a05, a20: local.a20, a4h: local.a4h, aAgd: local.aAgd, agendadoEm: sc.agendadoEm || local.agendadoEm };
          }
          return sc;
        });
        localStorage.setItem("cat_v4", JSON.stringify(merged));
        return merged;
      });
      setLastSync(new Date());
      if (!silent) toast("✅ Pipefy sincronizado!");
    } catch (e: any) {
      if (!silent) toast(`⚠ Erro Pipefy: ${e.message}`);
    }
  }, [fAnalista]);

  useEffect(() => {
    const local = localStorage.getItem("cat_v4");
    if (local) {
      try {
        const parsed = JSON.parse(local);
        if (Array.isArray(parsed)) setData(parsed.filter(Boolean).map((c: any) => {
          const t = Array.isArray(c.tentativas) ? c.tentativas : [false, false, false, false, false, false, false, false];
          while (t.length < 8) t.push(false);
          return { ...c, tentativas: t };
        }));
      } catch {}
    }
    fetchData(false);
  }, [fetchData]);

  useEffect(() => {
    pollRef.current = setInterval(() => fetchData(true), POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchData]);

  // Alert worker + Slack SLA alerts
  useEffect(() => {
    let alertToSet: any = null;
    setData(prev => {
      if (!Array.isArray(prev)) return [];
      let changed = false;
      const n = [...prev];
      const nowTs = now.getTime();
      n.filter(a => a && !a.encerrado).forEach(a => {
        const el = nowTs - (a.abertoEm || 0);
        const rest = LIM - el;
        const isMe = !fAnalista || a.analista === fAnalista;
        const isAnSel = (a.etapa || "").toLowerCase().includes("analista selecionado");
        if (isAnSel) {
          if (rest <= AV20 && rest > AV05 && !a.a20) {
            a.a20 = true; changed = true;
            // Slack alert: 20 min
            const key = `20_${a.id}`;
            if (!slackSent.current.has(key)) {
              slackSent.current.add(key);
              slackNotify({ type: "alerta_20min", analista: a.analista, cliente: a.cli, licenca: a.lic, minutos: Math.ceil(rest / 60000) });
            }
            if (isMe) alertToSet = { tipo: "urgente", titulo: "ATENÇÃO — PRAZO!", cli: a.cli.toUpperCase(), msg: `FALTAM ${Math.ceil(rest / 60000)} MINUTOS PARA O PRAZO DE 4H.` };
          }
          if (rest <= AV05 && rest > 0 && !a.a05) {
            a.a05 = true; changed = true;
            // Slack alert: 5 min
            const key = `05_${a.id}`;
            if (!slackSent.current.has(key)) {
              slackSent.current.add(key);
              slackNotify({ type: "alerta_5min", analista: a.analista, cliente: a.cli, licenca: a.lic, minutos: Math.ceil(rest / 60000) });
            }
            if (isMe) alertToSet = { tipo: "urgente", titulo: "PRAZO CRÍTICO!", cli: a.cli.toUpperCase(), msg: `APENAS ${Math.ceil(rest / 60000)} MINUTOS RESTANTES!` };
          }
          if (rest <= 0 && !a.a4h) {
            a.a4h = true; changed = true;
            // Slack alert: expired
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
              if (isMe) alertToSet = { tipo: "urgente", titulo: "📅 AGENDAMENTO EM 5 MIN!", cli: a.cli.toUpperCase(), msg: `Horário agendado: ${agd.toLocaleTimeString("pt-BR")}` };
            }
          }
        }
      });
      if (changed) localStorage.setItem("cat_v4", JSON.stringify(n));
      return changed ? n : prev;
    });
    if (alertToSet) { setAlerta(alertToSet); beep(700, 0.8); }
  }, [now, fAnalista]);

  // ── Actions ──
  const updateCard = async (id: string, changes: Partial<Atendimento>) => {
    setData(p => { const n = p.map(c => c.id === id ? { ...c, ...changes } : c); localStorage.setItem("cat_v4", JSON.stringify(n)); return n; });
    if (changes.etapa && phaseIds[changes.etapa]) {
      try { await pipefyQuery(`mutation { moveCardToPhase(input: { card_id: "${id}", destination_phase_id: "${phaseIds[changes.etapa]}" }) { card { id } } }`); } catch (e: any) { toast(`⚠ Erro: ${e.message}`); }
    }
  };

  const tent = (id: string, i: number) => {
    const a = data.find(x => x.id === id);
    if (!a || a.encerrado) return;
    const nt = [...a.tentativas];
    nt[i] = !nt[i];
    if (i === 2 && nt[2]) toast("📵 3ª tentativa! Considere encerrar.");
    updateCard(id, { tentativas: nt });
  };

  const addAt = () => {
    if (!novo.lic || !novo.cli) { toast("⚠ Preencha Licença e Cliente"); return; }
    const id = Date.now().toString();
    setData(p => {
      const n: Atendimento[] = [{ id, ...novo, etapa: ETAPAS[0], tentativas: [false, false, false, false, false, false, false, false], abertoEm: Date.now(), encerrado: false, encerradoEm: null, horaContato: novo.horaContato, analista: fAnalista || "", comentario: "", a20: false, a10: false, a4h: false, aAgd: false, a05: false, agendadoEm: "" }, ...p];
      localStorage.setItem("cat_v4", JSON.stringify(n));
      return n;
    });
    setNovo({ lic: "", cli: "", cel: "", horaContato: "", clas: "NFe", dem: "Alta", stat: "Normal" });
    toast("✅ Atendimento criado!");
  };

  const copyContactMsg = (a: Atendimento) => {
    const text = `Primeira tentativa de contato\n\nNome do cliente: ${a.cli}\nCelular: ${a.cel}\nHora: ${now.toLocaleTimeString()}\nAnalista: ${a.analista || fAnalista}`;
    navigator.clipboard.writeText(text);
    toast("📋 Mensagem copiada!");
  };

  const limEnc = () => {
    setData(p => { const n = p.filter(x => !x.encerrado); localStorage.setItem("cat_v4", JSON.stringify(n)); return n; });
    toast("🗑 Encerrados removidos");
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
    }).sort((a, b) => {
      // Prioridade por tempo: maior tempo aberto = maior prioridade (primeiro)
      return (a.abertoEm || 0) - (b.abertoEm || 0);
    });
  }, [data, busca, fClas, fDem, fAnalista]);

  // Agendados section
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
          <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-lg">🎯</div>
          <div>
            <h1 className="text-lg font-bold text-foreground tracking-tight">Central de Atendimentos</h1>
            <p className="text-xs text-muted-foreground">Gestão de chamados em tempo real • Slack + Pipefy</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={fAnalista}
            onChange={e => { setFAnalista(e.target.value); localStorage.setItem("cat_fAnalista", e.target.value); }}
            className="text-sm bg-card border border-border rounded-lg px-3 py-1.5 text-foreground outline-none focus:border-primary"
          >
            <option value="">👤 Todos</option>
            {analistasList.map(an => <option key={an} value={an}>{an}</option>)}
          </select>
          <button onClick={() => setDarkMode(!darkMode)} className="text-sm border border-border rounded-lg px-3 py-1.5 text-foreground hover:bg-muted transition-colors" title="Alternar tema">
            {darkMode ? "☀️" : "🌙"}
          </button>
          <button onClick={() => fetchData()} className="text-sm border border-border rounded-lg px-3 py-1.5 text-foreground hover:bg-muted transition-colors">↻ Sync</button>
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
          <div className="text-[0.7rem] text-muted-foreground">Prioridade máxima</div>
        </div>
        <div className="bg-card rounded-xl p-4 border border-border">
          <div className="text-[0.65rem] uppercase font-bold text-muted-foreground">Agendados</div>
          <div className="text-2xl font-extrabold text-vintage-yellow">{agendados.length}</div>
          <div className="text-[0.7rem] text-muted-foreground">Clientes agendados</div>
        </div>
        <div className="bg-card rounded-xl p-4 border border-border">
          <div className="text-[0.65rem] uppercase font-bold text-accent mb-1">Próximos a Vencer ⌛</div>
          {aVencer.slice(0, 3).map(t => {
            const rest = LIM - (now.getTime() - (t.abertoEm || 0));
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

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <input
          type="text"
          placeholder="🔍 Buscar licença ou cliente..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
          className="text-sm bg-card border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary min-w-[200px] flex-1 md:flex-none"
        />
        <select value={fClas} onChange={e => setFClas(e.target.value)} className="text-sm bg-card border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary">
          <option value="">Todas class.</option>
          {Object.keys(CHEX).map(c => <option key={c}>{c}</option>)}
        </select>
        <select value={fDem} onChange={e => setFDem(e.target.value)} className="text-sm bg-card border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary">
          <option value="">Toda demanda</option>
          <option value="Alta">🔴 Alta</option>
          <option value="Média">🟡 Média</option>
        </select>
        <button onClick={limEnc} className="text-sm text-destructive bg-destructive/10 border border-transparent rounded-lg px-3 py-2 font-semibold hover:bg-destructive/20 transition-colors">🗑 Limpar enc.</button>
        <div className="ml-auto text-xs text-muted-foreground font-medium">
          📋 {filtered.length} registro(s) {lastSync && `• Sync: ${lastSync.toLocaleTimeString("pt-BR")}`}
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
              fAnalista={fAnalista}
            />
          ))
        )}
      </div>

      {/* Agendados Section */}
      {agendados.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">📅</span>
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
                fAnalista={fAnalista}
              />
            ))}
          </div>
        </div>
      )}

      {/* New attendance form */}
      <div className="bg-card border border-border rounded-xl p-5 mb-6">
        <div className="text-sm font-bold text-accent mb-3">➕ Novo Atendimento</div>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Licença</label>
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
              {Object.keys(CHEX).map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Demanda</label>
            <select value={novo.dem} onChange={e => setNovo({ ...novo, dem: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-2 py-2 text-foreground outline-none focus:border-primary">
              <option value="Alta">🔴 Alta</option>
              <option value="Média">🟡 Média</option>
            </select>
          </div>
          <button onClick={addAt} className="bg-primary text-primary-foreground text-sm font-bold rounded-lg px-4 py-2 hover:opacity-90 transition-opacity">Adicionar ＋</button>
        </div>
      </div>

      {/* Toast */}
      <div id="toast-custom" className={toastMsg ? "show" : ""}>{toastMsg}</div>

      {/* Alert Modal */}
      {alerta && (
        <div className="modal-overlay" onClick={() => setAlerta(null)}>
          <div className="bg-card rounded-2xl p-8 max-w-md w-[90%] text-center border border-border shadow-medium animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="text-4xl mb-3">{alerta.tipo === "urgente" ? "🚨" : "⏰"}</div>
            <div className="text-lg font-extrabold text-foreground mb-1">{alerta.titulo}</div>
            <div className="text-sm font-semibold text-accent mb-2">👤 {alerta.cli}</div>
            <div className="text-sm text-muted-foreground mb-6 whitespace-pre-line">{alerta.msg}</div>
            <button onClick={() => setAlerta(null)} className="bg-primary text-primary-foreground w-full py-2.5 rounded-lg font-bold text-sm hover:opacity-90 transition-opacity">Entendido ✓</button>
          </div>
        </div>
      )}

      {/* Comment Modal */}
      {coment && (
        <div className="modal-overlay" onClick={() => setComent(null)}>
          <div className="bg-card rounded-2xl p-6 max-w-md w-[90%] border border-border shadow-medium animate-fade-in" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-accent mb-3">💬 Comentário</h3>
            <textarea
              value={coment.text}
              onChange={e => setComent({ ...coment, text: e.target.value })}
              className="w-full h-28 p-3 rounded-lg border border-border bg-muted text-foreground text-sm outline-none focus:border-primary resize-none"
              placeholder="Escreva algo..."
            />
            <div className="flex gap-2 justify-end mt-3">
              <button onClick={() => setComent(null)} className="text-sm px-4 py-2 rounded-lg border border-border text-foreground hover:bg-muted transition-colors">Cancelar</button>
              <button onClick={() => { updateCard(coment.id, { comentario: coment.text }); setComent(null); toast("✅ Comentário salvo!"); }} className="text-sm px-4 py-2 rounded-lg bg-primary text-primary-foreground font-bold hover:opacity-90 transition-opacity">Salvar</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {modEdit && (
        <div className="modal-overlay" onClick={() => setModEdit(null)}>
          <div className="bg-card rounded-2xl p-6 max-w-lg w-[90%] border border-border shadow-medium animate-fade-in" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-accent mb-4">✏️ Editar Atendimento</h3>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="flex flex-col gap-1">
                <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Licença</label>
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
                <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Classificação</label>
                <select value={modEdit.clas} onChange={e => setModEdit({ ...modEdit, clas: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary">
                  {Object.keys(CHEX).map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Demanda</label>
                <select value={modEdit.dem} onChange={e => setModEdit({ ...modEdit, dem: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary">
                  <option value="Alta">Alta</option>
                  <option value="Média">Média</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[0.65rem] uppercase font-bold text-muted-foreground">Analista</label>
                <input value={modEdit.analista} onChange={e => setModEdit({ ...modEdit, analista: e.target.value })} className="text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground outline-none focus:border-primary" />
              </div>
            </div>
            <div className="flex gap-2 justify-end border-t border-border pt-3">
              <button onClick={() => setModEdit(null)} className="text-sm px-4 py-2 rounded-lg border border-border text-foreground hover:bg-muted transition-colors">Cancelar</button>
              <button onClick={() => { updateCard(modEdit.id, { ...modEdit }); setModEdit(null); toast("✅ Atualizado!"); }} className="text-sm px-4 py-2 rounded-lg bg-primary text-primary-foreground font-bold hover:opacity-90 transition-opacity">Salvar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
