import { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";

// ── Config ──
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

export interface Atendimento {
  id: string;
  lic: string;
  cli: string;
  cel: string;
  clas: string;
  dem: string;
  stat: string;
  etapa: string;
  tentativas: boolean[];
  abertoEm: number;
  encerrado: boolean;
  encerradoEm?: number | null;
  horaContato: string;
  analista: string;
  comentario: string;
  a20: boolean;
  a10: boolean;
  a4h: boolean;
  aAgd: boolean;
  a05: boolean;
  agendadoEm?: string;
  _original?: unknown;
}

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

export default function AttendanceCard({ item: a, index, now, onUpdateCard, onComment, onEdit, onCopyMsg, onToggleTent, fAnalista }: Props) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [expanded, a]);

  const nowTs = now.getTime();
  const ab = a.abertoEm || nowTs;
  const el = a.encerrado ? (a.encerradoEm || nowTs) - ab : nowTs - ab;
  const rest = LIM - el;
  const pct = Math.min(100, Math.round((el / LIM) * 100));
  const cor = rest <= AV10 ? "hsl(var(--red))" : rest <= AV20 ? "hsl(var(--yellow))" : "hsl(var(--green))";

  const isVencido = rest < 0;
  const timeClass = a.encerrado ? "text-muted-foreground" : isVencido ? "text-destructive" : rest <= AV10 ? "text-destructive" : rest <= AV20 ? "text-vintage-yellow" : "text-vintage-green";

  const isZebra = index % 2 === 1;
  const ela = nowTs - (a.abertoEm || 0);

  // Ensure 8 tentativas
  const tentativas = [...(a.tentativas || [])];
  while (tentativas.length < 8) tentativas.push(false);

  // Agendado info
  const isAgendado = (a.etapa || "").toLowerCase().includes("agendado");
  const agendadoDate = parseDate(a.agendadoEm || a.horaContato);

  return (
    <div
      className={`rounded-md border transition-all duration-200 cursor-pointer ${
        isZebra ? "bg-card-alt" : "bg-card"
      } ${a.encerrado ? "opacity-60" : ""} ${
        a.dem === "Alta" && !a.encerrado ? "border-l-[3px] border-l-destructive" : "border-border"
      } hover:shadow-medium`}
      style={{ boxShadow: "var(--shadow-card)" }}
    >
      {/* Compact header */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <div
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
            a.dem === "Alta" ? "bg-destructive" : "bg-vintage-yellow"
          }`}
          title={a.dem}
        />

        <div className="flex-1 min-w-0">
          <span className="font-bold text-foreground text-sm truncate block" title={a.cli}>
            {a.cli || "—"}
          </span>
        </div>

        {/* Tentativas inline */}
        <div className="flex gap-0.5 flex-shrink-0">
          {tentativas.map((done, i) => {
            const isPrimary = i < 3;
            let bg = "bg-muted border-border text-muted-foreground";
            if (done) {
              bg = isPrimary
                ? TENT_COLORS_PRIMARY[i]
                : TENT_COLORS_SECONDARY[i - 3] || "bg-muted-foreground border-muted-foreground text-background";
            }
            return (
              <button
                key={i}
                className={`w-5 h-5 rounded text-[0.55rem] font-bold border flex items-center justify-center transition-all ${bg}`}
                onClick={(e) => { e.stopPropagation(); onToggleTent(a.id, i); }}
                title={`Tentativa ${i + 1}`}
              >
                {done ? "✓" : i + 1}
              </button>
            );
          })}
        </div>

        {/* Agendado badge */}
        {isAgendado && agendadoDate && (
          <span className="text-[0.6rem] font-bold px-1.5 py-0.5 rounded bg-vintage-yellow/20 text-vintage-yellow flex-shrink-0" title="Agendamento">
            📅 {agendadoDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} {agendadoDate.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}

        <div className="flex-shrink-0">
          <span className="font-mono text-xs font-semibold text-brown-light bg-sand px-2 py-0.5 rounded">
            {a.lic}
          </span>
        </div>

        <div className="flex-shrink-0 min-w-[80px] text-right">
          <span className={`font-mono text-xs font-bold ${timeClass}`}>
            {fmt(el)}
          </span>
        </div>

        <span className={`text-[0.65rem] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${CCOR[a.clas] || "badge-nfe"}`}>
          {a.clas}
        </span>

        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform duration-300 flex-shrink-0 ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </div>

      {/* Expandable details */}
      <div
        ref={contentRef}
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{
          maxHeight: expanded ? `${contentHeight}px` : "0px",
          opacity: expanded ? 1 : 0,
        }}
      >
        <div className="px-4 pb-4 pt-1 border-t border-border/50">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm mb-3">
            <div>
              <span className="text-[0.65rem] uppercase font-bold text-muted-foreground tracking-wider block">Analista</span>
              <span className="font-medium text-foreground truncate block" title={a.analista}>{a.analista || "—"}</span>
            </div>
            <div>
              <span className="text-[0.65rem] uppercase font-bold text-muted-foreground tracking-wider block">Celular</span>
              <span className="font-medium text-foreground">{a.cel || "—"}</span>
            </div>
            <div>
              <span className="text-[0.65rem] uppercase font-bold text-muted-foreground tracking-wider block">Classificação</span>
              <span className={`text-xs font-bold px-2 py-0.5 rounded inline-block mt-0.5 ${CCOR[a.clas] || "badge-nfe"}`}>{a.clas}</span>
            </div>
            <div>
              <span className="text-[0.65rem] uppercase font-bold text-muted-foreground tracking-wider block">Demanda</span>
              <span className={`font-semibold text-xs ${a.dem === "Alta" ? "text-destructive" : "text-vintage-yellow"}`}>
                {a.dem === "Alta" ? "🔴 Alta" : "🟡 Média"}
              </span>
            </div>
            <div>
              <span className="text-[0.65rem] uppercase font-bold text-muted-foreground tracking-wider block">Etapa</span>
              {a.encerrado ? (
                <span className="text-xs text-muted-foreground">{ETAPAS_ABR[a.etapa] || a.etapa}</span>
              ) : (
                <select
                  className="text-xs bg-muted border border-border rounded px-1.5 py-1 text-foreground outline-none focus:border-primary w-full mt-0.5"
                  value={a.etapa}
                  onClick={(e) => e.stopPropagation()}
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
                  {ETAPAS.map((e) => (<option key={e} value={e}>{ETAPAS_ABR[e] || e}</option>))}
                  {!ETAPAS.includes(a.etapa) && <option value={a.etapa}>{a.etapa}</option>}
                </select>
              )}
            </div>
            {/* Agendamento info */}
            {isAgendado && (
              <div>
                <span className="text-[0.65rem] uppercase font-bold text-muted-foreground tracking-wider block">Agendamento</span>
                {agendadoDate ? (
                  <span className="text-xs font-bold text-vintage-yellow">
                    📅 {agendadoDate.toLocaleDateString("pt-BR")} às {agendadoDate.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Sem data definida</span>
                )}
              </div>
            )}
            {/* Tentativas */}
            <div className={isAgendado ? "" : "md:col-span-1"}>
              <span className="text-[0.65rem] uppercase font-bold text-muted-foreground tracking-wider block">Tentativas</span>
              <div className="flex gap-1 mt-1 flex-wrap">
                {tentativas.map((done, i) => {
                  const isPrimary = i < 3;
                  const isAnSel = (a.etapa || "").toLowerCase().includes("analista selecionado");
                  const isHoraContato = (a.etapa || "").toLowerCase().includes("hora do primeiro contato");
                  let bg = "bg-muted border-border";
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
                      className={`w-6 h-6 rounded text-[0.65rem] font-bold border flex items-center justify-center transition-all ${bg}`}
                      onClick={(e) => { e.stopPropagation(); if (!isAnSel && !(i === 0 && isHoraContato)) onToggleTent(a.id, i); }}
                      style={{ cursor: isAnSel ? "not-allowed" : "pointer", opacity: isAnSel ? 0.4 : 1 }}
                    >
                      {done ? "✓" : txt}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Prazo 4h */}
          {(a.etapa || "").toLowerCase().includes("analista selecionado") && !a.encerrado && (
            <div className="mb-3">
              <span className="text-[0.65rem] uppercase font-bold text-muted-foreground tracking-wider">Prazo 4h</span>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: cor }} />
                </div>
                <span className="font-mono text-xs font-bold min-w-[60px] text-right" style={{ color: cor }}>
                  {fmtM(rest, a.etapa)}
                </span>
              </div>
            </div>
          )}

          {/* Ações */}
          <div className="flex items-center gap-1 pt-2 border-t border-border/30">
            <button
              className="text-sm px-2 py-1 rounded hover:bg-muted transition-colors"
              onClick={(e) => { e.stopPropagation(); onComment(a.id, a.comentario || ""); }}
              title="Comentário"
            >💬</button>
            <button
              className="text-sm px-2 py-1 rounded hover:bg-muted transition-colors"
              onClick={(e) => { e.stopPropagation(); onEdit(a); }}
              title="Editar"
            >✏️</button>
            <button
              className="text-sm px-2 py-1 rounded hover:bg-muted transition-colors"
              onClick={(e) => { e.stopPropagation(); onCopyMsg(a); }}
              title="Copiar mensagem"
            >📋</button>
            <div className="flex-1" />
            {a.encerrado ? (
              <button
                className="text-xs px-3 py-1 rounded bg-vintage-blue/10 text-vintage-blue font-semibold hover:bg-vintage-blue/20 transition-colors"
                onClick={(e) => { e.stopPropagation(); onUpdateCard(a.id, { etapa: "Analista Selecionado", encerrado: false, encerradoEm: null }); }}
              >↩ Reabrir</button>
            ) : (
              <button
                className="text-xs px-3 py-1 rounded bg-destructive/10 text-destructive font-semibold hover:bg-destructive/20 transition-colors"
                onClick={(e) => { e.stopPropagation(); onUpdateCard(a.id, { etapa: "Finalizado", encerrado: true, encerradoEm: Date.now() }); }}
              >✕ Encerrar</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
