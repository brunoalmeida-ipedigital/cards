import { useState, useCallback } from "react";
import { type Atendimento } from "./AttendanceCard";

interface Props {
  item: Atendimento;
  index: number;
  now: Date;
  onUpdateCard: (id: string, changes: Partial<Atendimento>) => void;
  onComment: (id: string, text: string) => void;
  onEdit: (item: Atendimento) => void;
  onCopyMsg: (item: Atendimento) => void;
  onToggleTent: (id: string, i: number) => void;
  fAnalista: string;
}

const ETAPAS = [
  "Caixa de entrada", "Analista Selecionado", "Hora primeiro contato",
  "Cliente Agendado/Reagendado", "Parado", "Em Configuração",
  "Finalizado em", "Arquivado", "Concluído"
];
const ETAPAS_ABR: Record<string, string> = {
  "Caixa de entrada": "Cx. Entrada", "Analista Selecionado": "An. Selec.",
  "Hora primeiro contato": "1º Contato", "Cliente Agendado/Reagendado": "Agenda/Reagd",
  "Parado": "Parado", "Em Configuração": "Em Config.",
  "Finalizado em": "Finalizado", "Arquivado": "Arquivado", "Concluído": "Concluído"
};

const CCOR: Record<string, string> = {
  NFe: "badge-nfe", "NFe SC": "badge-nfesc", "Boleto Fácil": "badge-bol",
  "Boleto Tradicional": "badge-bolt", TEF: "badge-tef", Impressora: "badge-imp", Etiqueta: "badge-eti",
};

const TENT_COLORS_PRIMARY = [
  "bg-primary border-primary text-primary-foreground",
  "bg-primary border-primary text-primary-foreground",
  "bg-primary border-primary text-primary-foreground",
];
const TENT_COLORS_SECONDARY = [
  "bg-accent/60 border-accent text-accent-foreground",
  "bg-vintage-yellow/40 border-vintage-yellow text-foreground",
  "bg-vintage-blue/30 border-vintage-blue text-foreground",
  "bg-sage/40 border-sage text-foreground",
  "bg-terracotta/30 border-terracotta text-foreground",
];

const p2 = (n: number) => String(n).padStart(2, "0");
const fmt = (ms: number) => {
  if (ms < 0) return "00:00:00";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${p2(h % 24)}:${p2(m)}:${p2(s)}`; }
  return `${p2(h)}:${p2(m)}:${p2(s)}`;
};
const fmtM = (ms: number, etapa?: string) => {
  if (etapa && !etapa.toLowerCase().includes("analista selecionado")) return "—";
  if (!ms || isNaN(ms)) return "—";
  if (ms <= 0) return "Vencido!";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
  return h > 0 ? `${h}h ${p2(m)}m` : `${m}m ${Math.floor((ms % 60000) / 1000)}s`;
};

const LIM = 4 * 3600000;
const AV20 = 20 * 60000;
const AV10 = 10 * 60000;

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

export default function AttendanceCardGrid({ item: a, index, now, onUpdateCard, onComment, onEdit, onCopyMsg, onToggleTent, fAnalista }: Props) {
  const nowTs = now.getTime();
  const ab = a.abertoEm || nowTs;
  const el = a.encerrado ? (a.encerradoEm || nowTs) - ab : nowTs - ab;
  const rest = LIM - el;
  const pct = Math.min(100, Math.round((el / LIM) * 100));
  const cor = rest <= AV10 ? "hsl(var(--red))" : rest <= AV20 ? "hsl(var(--yellow))" : "hsl(var(--green))";

  const isVencido = rest < 0;
  const timeClass = a.encerrado ? "text-muted-foreground" : isVencido ? "text-destructive" : rest <= AV10 ? "text-destructive" : rest <= AV20 ? "text-vintage-yellow" : "text-vintage-green";

  const ela = nowTs - (a.abertoEm || 0);

  // 🔥 "Card em Fogo": +4h sem contato OU +24h aberto
  const IS_FIRE = !a.encerrado && (rest < 0 || ela > 24 * 3600000);
  // 🟡 Gargalo: em estágio que não é final e parado (etapa estável + ela > 1h)
  const IS_GARGALO = !a.encerrado && !IS_FIRE && ela > 3600000 &&
    !(a.etapa || "").toLowerCase().includes("analista selecionado");

  // 📋 One-click copy helper
  const [copied, setCopied] = useState<string | null>(null);
  const copyField = useCallback((val: string, key: string) => {
    navigator.clipboard.writeText(val);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  // Ensure 8 tentativas
  const tentativas = [...(a.tentativas || [])];
  while (tentativas.length < 8) tentativas.push(false);

  // Agendado info
  const isAgendado = (a.etapa || "").toLowerCase().includes("agendado");
  const agendadoDate = parseDate(a.agendadoEm || a.horaContato);

  return (
    <div
      className={`relative flex flex-col rounded-xl border transition-all duration-200 p-4 ${
        IS_FIRE
          ? "card-fire bg-card"
          : IS_GARGALO
          ? "card-gargalo"
          : "bg-card"
      } ${a.encerrado ? "opacity-60" : ""} ${
        IS_FIRE
          ? "border-red-500 shadow-lg shadow-red-500/20"
          : a.dem === "Alta" && !a.encerrado ? "border-l-[4px] border-l-destructive border-border" : "border-border hover:shadow-medium"
      }`}
    >
      {/* Header do Card */}
      <div className="flex justify-between items-start mb-2">
        <div className="flex flex-col">
          <span className={`text-[0.65rem] font-bold px-2 py-0.5 rounded-full w-fit mb-1 ${CCOR[a.clas] || "badge-nfe"}`}>
            {a.clas}
          </span>
          <span className="font-bold text-foreground text-base leading-tight break-words" title={a.cli}>
            {a.cli || "—"}
          </span>
        </div>
        <div className="flex flex-col items-end shrink-0 pl-2">
          {a.dem === "Alta" && (
            <span className="text-[0.65rem] font-bold text-destructive flex items-center gap-1 bg-destructive/10 px-1.5 py-0.5 rounded mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" /> ALTA
            </span>
          )}
          <span className={`font-mono text-sm font-bold ${timeClass}`}>
            {fmt(el)}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 mb-3 text-sm">
        <div>
          <span className="text-[0.65rem] uppercase font-bold text-muted-foreground block">Licença</span>
          <span
            className={`font-mono font-semibold text-xs cursor-pointer px-1.5 py-0.5 rounded copy-hover transition-colors ${copied === "lic" ? "bg-green-500/20 text-green-400" : "text-brown-light bg-sand/50"}`}
            title="Copiar licença"
            onClick={(e) => { e.stopPropagation(); copyField(a.lic, "lic"); }}
          >
            {copied === "lic" ? "✓ Copiado" : a.lic}
          </span>
        </div>
        <div>
          <span className="text-[0.65rem] uppercase font-bold text-muted-foreground block">Telefone</span>
          <span
            className={`font-semibold text-xs cursor-pointer transition-colors ${copied === "cel" ? "text-green-400" : "text-foreground hover:text-primary"}`}
            title="Copiar telefone"
            onClick={(e) => { e.stopPropagation(); if (a.cel) copyField(a.cel, "cel"); }}
          >
            {copied === "cel" ? "✓ Copiado" : (a.cel || "—")}
          </span>
        </div>
        <div>
          <span className="text-[0.65rem] uppercase font-bold text-muted-foreground block">Analista</span>
          <span className="font-semibold text-xs text-foreground bg-muted px-1.5 py-0.5 rounded" title={a.analista}>
            👤 {a.analista || "—"}
          </span>
        </div>
      </div>

      {/* Agendamento */}
      {isAgendado && agendadoDate && (
        <div className="bg-vintage-yellow/10 border border-vintage-yellow/30 rounded-lg p-2 mb-3 flex items-center gap-2">
          <span className="text-xl">📅</span>
          <div>
            <span className="text-[0.65rem] uppercase font-bold text-vintage-yellow flex items-center">Agendamento</span>
            <span className="text-xs font-bold text-foreground">
              {agendadoDate.toLocaleDateString("pt-BR")} às {agendadoDate.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        </div>
      )}

      {/* Etapa Select */}
      <div className="mb-3">
        <span className="text-[0.65rem] uppercase font-bold text-muted-foreground block mb-0.5">Etapa</span>
        {a.encerrado ? (
          <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded block">{a.etapa}</span>
        ) : (
          <select
            className="text-xs bg-muted border border-border rounded-lg px-2 py-1.5 text-foreground outline-none focus:border-primary w-full transition-colors"
            value={a.etapa}
            onChange={(e) => {
              const newEtapa = e.target.value;
              const changes: Partial<Atendimento> = { etapa: newEtapa };
              if (newEtapa.toLowerCase().includes("hora primeiro contato")) {
                const nt = [...tentativas];
                nt[0] = true;
                changes.tentativas = nt;
              }
              onUpdateCard(a.id, changes);
            }}
          >
            {ETAPAS.map((e) => (<option key={e} value={e}>{e}</option>))}
            {!ETAPAS.includes(a.etapa) && <option value={a.etapa}>{a.etapa}</option>}
          </select>
        )}
      </div>

      {/* Tentativas */}
      <div className="mb-4 flex-grow">
        <span className="text-[0.65rem] uppercase font-bold text-muted-foreground block mb-1">Tentativas</span>
        <div className="flex gap-1.5 flex-wrap">
          {tentativas.map((done, i) => {
            const isPrimary = i < 3;
            const isAnSel = (a.etapa || "").toLowerCase().includes("analista selecionado");
            const isHoraContato = (a.etapa || "").toLowerCase().includes("hora do primeiro contato");
            let bg = "bg-muted border-border hover:bg-muted/80 text-muted-foreground";
            let txt = String(i + 1);

            if (i === 0 && isHoraContato) {
              bg = ela > 8 * 3600000 ? "bg-destructive border-destructive text-destructive-foreground" : "bg-vintage-green border-vintage-green text-primary-foreground";
              txt = "✓";
            } else if (done) {
              bg = isPrimary
                ? TENT_COLORS_PRIMARY[i]
                : TENT_COLORS_SECONDARY[i - 3] || "bg-muted-foreground border-muted-foreground text-background";
            }

            return (
              <button
                key={i}
                className={`w-7 h-7 rounded-md text-[0.7rem] font-bold border flex items-center justify-center transition-all shadow-sm ${bg}`}
                onClick={(e) => { e.stopPropagation(); if (!isAnSel && !(i === 0 && isHoraContato)) onToggleTent(a.id, i); }}
                style={{ cursor: isAnSel ? "not-allowed" : "pointer", opacity: isAnSel ? 0.4 : 1 }}
                title={`Tentativa ${i + 1}`}
              >
                {done ? "✓" : txt}
              </button>
            );
          })}
        </div>
      </div>

      {/* Prazo 4h ProgressBar */}
      {(a.etapa || "").toLowerCase().includes("analista selecionado") && !a.encerrado && (
        <div className="mt-auto mb-3">
          <div className="flex justify-between items-end mb-1">
            <span className="text-[0.65rem] uppercase font-bold text-muted-foreground">Prazo 4h</span>
            <span className="font-mono text-xs font-bold" style={{ color: cor }}>
              {fmtM(rest, a.etapa)}
            </span>
          </div>
          <div className="w-full h-2 bg-muted rounded-full overflow-hidden shadow-inner">
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: cor }} />
          </div>
        </div>
      )}

      {/* Botoes de Acao */}
      <div className="flex items-center gap-2 pt-3 mt-auto border-t border-border/50">
        <button
          className="flex-1 flex justify-center items-center gap-1 text-xs px-3 py-2 rounded-lg bg-muted hover:bg-muted/80 text-foreground font-semibold transition-colors border border-transparent shadow-sm"
          onClick={() => onComment(a.id, a.comentario || "")}
        >
          💬 Comentar
        </button>
        <button
          className="w-10 flex justify-center items-center text-sm py-2 rounded-lg bg-muted hover:bg-muted/80 text-foreground transition-colors shadow-sm"
          onClick={() => onEdit(a)}
          title="Editar"
        >
          ✏️
        </button>
        <button
          className="w-10 flex justify-center items-center text-sm py-2 rounded-lg bg-muted hover:bg-muted/80 text-foreground transition-colors shadow-sm"
          onClick={() => onCopyMsg(a)}
          title="Copiar mensagem inicial"
        >
          📋
        </button>
        {a.encerrado ? (
          <button
            className="w-10 flex justify-center items-center text-sm py-2 rounded-lg bg-vintage-blue/10 text-vintage-blue hover:bg-vintage-blue/20 transition-colors shadow-sm"
            onClick={() => onUpdateCard(a.id, { etapa: "Analista Selecionado", encerrado: false, encerradoEm: null })}
            title="Reabrir"
          >
            ↩
          </button>
        ) : (
          <button
            className="w-10 flex justify-center items-center text-sm py-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors shadow-sm"
            onClick={() => onUpdateCard(a.id, { etapa: "Finalizado", encerrado: true, encerradoEm: Date.now() })}
            title="Encerrar"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
