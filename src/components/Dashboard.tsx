import { useState, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import type { Atendimento } from "./AttendanceCard";
import DashboardLegacy from "./DashboardLegacy";
import { calcBusinessElapsed } from "@/lib/businessHours";

const NEON_RED = "#ff073a";
const EMERALD = "#50C878";
const AMBER = "#f59e0b";
const BLUE_INFO = "#3b82f6";
const ORANGE_HEAVY = "#ff6b35";

const EFFORT_WEIGHTS: Record<string, number> = {
  Impressora: 3, "Boleto Fácil": 2, "Boleto Tradicional": 2,
  TEF: 2.5, NFe: 1, "NFe SC": 1.5, Etiqueta: 1,
};

const CLAS_COLORS: Record<string, string> = {
  NFe: "#2563eb", "NFe SC": "#7c3aed", "Boleto Fácil": "#0891b2",
  "Boleto Tradicional": "#0369a1", TEF: "#15803d", Impressora: "#ea580c", Etiqueta: "#d97706",
};

interface Props {
  data: Atendimento[];
  now: Date;
}

const LIM = 4 * 3600000;
const p2 = (n: number) => String(n).padStart(2, "0");
const fmtTime = (ms: number) => {
  if (ms < 0) ms = Math.abs(ms);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${p2(h % 24)}:${p2(m)}:${p2(s)}`; }
  return `${p2(h)}:${p2(m)}:${p2(s)}`;
};

export default function Dashboard({ data, now }: Props) {
  const [showLegacy, setShowLegacy] = useState(false);

  // Filter to current month (day 1 to end of month), including cards from previous months that are still active
  const monthlyData = useMemo(() => {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    return data.filter(a => {
      if (!a) return false;
      // Include if: opened this month OR still active (not closed)
      const openedThisMonth = (a.abertoEm || 0) >= startOfMonth && (a.abertoEm || 0) <= endOfMonth;
      const stillActive = !a.encerrado;
      return openedThisMonth || stillActive;
    });
  }, [data, now]);

  const active = useMemo(() => monthlyData.filter(a => a && !a.encerrado), [monthlyData]);
  const nowTs = now.getTime();

  // Traffic light system
  const trafficLight = useMemo(() => {
    let red = 0, yellow = 0, green = 0;
    active.forEach(a => {
      const elapsed = calcBusinessElapsed(a.abertoEm || nowTs, nowTs);
      const isAnSel = (a.etapa || "").toLowerCase().includes("analista selecionado");
      const total24 = nowTs - (a.abertoEm || nowTs);

      if ((isAnSel && elapsed > LIM) || total24 > 24 * 3600000) {
        red++;
      } else if (elapsed > LIM / 2) {
        yellow++;
      } else {
        green++;
      }
    });
    return { red, yellow, green, total: active.length };
  }, [active, nowTs]);

  // Oldest card time
  const oldestCard = useMemo(() => {
    if (active.length === 0) return null;
    const oldest = active.reduce((prev, curr) => {
      return (curr.abertoEm || nowTs) < (prev.abertoEm || nowTs) ? curr : prev;
    });
    return {
      ...oldest,
      elapsed: nowTs - (oldest.abertoEm || nowTs),
    };
  }, [active, nowTs]);

  // "Pegando Fogo" - Top 5 most delayed
  const pegandoFogo = useMemo(() => {
    return active
      .filter(a => (a.etapa || "").toLowerCase().includes("analista selecionado"))
      .map(a => ({
        ...a,
        businessElapsed: calcBusinessElapsed(a.abertoEm || nowTs, nowTs),
        delay: calcBusinessElapsed(a.abertoEm || nowTs, nowTs) - LIM,
      }))
      .filter(a => a.delay > 0)
      .sort((a, b) => b.delay - a.delay)
      .slice(0, 5);
  }, [active, nowTs]);

  // "Gargalo" - Cards stuck > 1h in any stage
  const gargalo = useMemo(() => {
    return active
      .map(a => ({
        ...a,
        elapsed: nowTs - (a.abertoEm || nowTs),
      }))
      .filter(a => a.elapsed > 3600000)
      .sort((a, b) => b.elapsed - a.elapsed);
  }, [active, nowTs]);

  // Top Performance - SLA % by analyst
  const topPerformance = useMemo(() => {
    const map: Record<string, { ok: number; total: number }> = {};
    active.forEach(a => {
      const name = a.analista || "Sem analista";
      const elapsed = calcBusinessElapsed(a.abertoEm || nowTs, nowTs);
      if (!map[name]) map[name] = { ok: 0, total: 0 };
      map[name].total++;
      if (elapsed <= LIM) map[name].ok++;
    });
    return Object.entries(map)
      .map(([name, v]) => ({
        name,
        percentual: v.total > 0 ? Math.round((v.ok / v.total) * 100) : 0,
        total: v.total,
        ok: v.ok,
      }))
      .sort((a, b) => b.percentual - a.percentual);
  }, [active, nowTs]);

  // Cards by analyst with effort
  const porAnalista = useMemo(() => {
    const map: Record<string, { total: number; alta: number; media: number; effort: number }> = {};
    active.forEach(a => {
      const name = a.analista || "Sem analista";
      if (!map[name]) map[name] = { total: 0, alta: 0, media: 0, effort: 0 };
      map[name].total++;
      map[name].effort += EFFORT_WEIGHTS[a.clas] || 1;
      if (a.dem === "Alta") map[name].alta++;
      else map[name].media++;
    });
    return Object.entries(map).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.effort - a.effort);
  }, [active]);

  // Classification distribution with heatmap colors
  const porClassificacao = useMemo(() => {
    const map: Record<string, number> = {};
    active.forEach(a => {
      const c = a.clas || "Outros";
      map[c] = (map[c] || 0) + 1;
    });
    return Object.entries(map)
      .map(([name, value]) => ({
        name, value,
        color: (name === "TEF" || name === "NFe") ? ORANGE_HEAVY : (CLAS_COLORS[name] || BLUE_INFO),
      }))
      .sort((a, b) => b.value - a.value);
  }, [active]);

  // Cards by stage
  const porEtapa = useMemo(() => {
    const map: Record<string, number> = {};
    active.forEach(a => {
      const e = a.etapa || "Desconhecido";
      map[e] = (map[e] || 0) + 1;
    });
    return Object.entries(map)
      .map(([name, value]) => ({ name: name.length > 20 ? name.slice(0, 18) + "..." : name, fullName: name, value }))
      .sort((a, b) => b.value - a.value);
  }, [active]);

  const customTooltip = ({ active: a, payload, label }: any) => {
    if (!a || !payload?.length) return null;
    return (
      <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 shadow-lg text-xs">
        <p className="font-bold text-white mb-1">{label}</p>
        {payload.map((p: any, i: number) => (
          <p key={i} style={{ color: p.color || "#fff" }} className="font-medium">{p.name}: {p.value}</p>
        ))}
      </div>
    );
  };

  if (showLegacy) {
    return (
      <div>
        <div className="flex justify-end mb-3">
          <button
            onClick={() => setShowLegacy(false)}
            className="text-sm border border-border rounded-lg px-3 py-1.5 text-foreground hover:bg-muted transition-colors"
          >
            Voltar ao Dashboard Novo
          </button>
        </div>
        <DashboardLegacy data={data} now={now} />
      </div>
    );
  }

  return (
    <div className="space-y-5 bg-gray-950 rounded-2xl p-5 -mx-1">
      {/* Toggle + Oldest card counter */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {oldestCard && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 uppercase font-bold">Card mais antigo:</span>
              <span className="font-mono text-2xl font-extrabold" style={{ color: NEON_RED }}>
                {fmtTime(oldestCard.elapsed)}
              </span>
              <span className="text-xs text-gray-500">({oldestCard.cli?.slice(0, 15) || oldestCard.lic})</span>
            </div>
          )}
        </div>
        <button
          onClick={() => setShowLegacy(true)}
          className="text-xs border border-gray-700 rounded-lg px-3 py-1.5 text-gray-400 hover:bg-gray-800 transition-colors"
        >
          Dashboard Antigo
        </button>
      </div>

      {/* Traffic Light KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl p-4 text-center border-2" style={{ borderColor: NEON_RED, background: `${NEON_RED}15` }}>
          <div className="text-[0.65rem] uppercase font-bold" style={{ color: NEON_RED }}>Critico</div>
          <div className="text-3xl font-extrabold" style={{ color: NEON_RED }}>{trafficLight.red}</div>
          <div className="text-[0.6rem] text-gray-400">Cards {">"}4h ou {">"}24h</div>
        </div>
        <div className="rounded-xl p-4 text-center border-2" style={{ borderColor: AMBER, background: `${AMBER}15` }}>
          <div className="text-[0.65rem] uppercase font-bold" style={{ color: AMBER }}>Atencao</div>
          <div className="text-3xl font-extrabold" style={{ color: AMBER }}>{trafficLight.yellow}</div>
          <div className="text-[0.6rem] text-gray-400">{">"}2h (50% SLA)</div>
        </div>
        <div className="rounded-xl p-4 text-center border-2" style={{ borderColor: EMERALD, background: `${EMERALD}15` }}>
          <div className="text-[0.65rem] uppercase font-bold" style={{ color: EMERALD }}>Operacional</div>
          <div className="text-3xl font-extrabold" style={{ color: EMERALD }}>{trafficLight.green}</div>
          <div className="text-[0.6rem] text-gray-400">Dentro do prazo</div>
        </div>
        <div className="rounded-xl p-4 text-center border-2" style={{ borderColor: BLUE_INFO, background: `${BLUE_INFO}15` }}>
          <div className="text-[0.65rem] uppercase font-bold" style={{ color: BLUE_INFO }}>Total</div>
          <div className="text-3xl font-extrabold text-white">{trafficLight.total}</div>
          <div className="text-[0.6rem] text-gray-400">Volume do mes</div>
        </div>
      </div>

      {/* 3 columns: Pegando Fogo / Carga por Analista / Classificacao */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Pegando Fogo */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
            <span style={{ color: NEON_RED }}>🔥</span> Pegando Fogo
          </h3>
          {pegandoFogo.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-4">Nenhum card atrasado!</p>
          ) : (
            <div className="space-y-2">
              {pegandoFogo.map((a, i) => (
                <div key={a.id} className="flex items-center justify-between bg-gray-800/50 rounded-lg px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-white truncate">{a.cli || a.lic}</div>
                    <div className="text-[0.6rem] text-gray-400">{a.analista || "—"} · {a.clas}</div>
                  </div>
                  <span className="font-mono text-xs font-bold ml-2" style={{ color: NEON_RED }}>
                    +{fmtTime(a.delay)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Carga por Analista (Esforco Estimado) */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-bold text-white mb-3">📊 Carga por Analista (Esforco)</h3>
          {porAnalista.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-4">Sem dados</p>
          ) : (
            <div className="space-y-2">
              {porAnalista.map(a => {
                const maxEffort = Math.max(...porAnalista.map(x => x.effort), 1);
                const pct = Math.round((a.effort / maxEffort) * 100);
                return (
                  <div key={a.name}>
                    <div className="flex justify-between text-xs mb-0.5">
                      <span className="text-gray-300 font-medium">{a.name}</span>
                      <span className="text-gray-400">{a.total} cards · {a.effort.toFixed(1)} pts</span>
                    </div>
                    <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${pct}%`,
                          background: a.alta > a.media ? NEON_RED : EMERALD,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Classificacao de Problemas (Heatmap style) */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-bold text-white mb-3">🏷️ Classificacao de Problemas</h3>
          {porClassificacao.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-4">Sem dados</p>
          ) : (
            <div className="space-y-2">
              {porClassificacao.map(c => {
                const maxVal = Math.max(...porClassificacao.map(x => x.value), 1);
                const pct = Math.round((c.value / maxVal) * 100);
                const isHeavy = c.name === "TEF" || c.name === "NFe";
                return (
                  <div key={c.name}>
                    <div className="flex justify-between text-xs mb-0.5">
                      <span className={`font-medium ${isHeavy ? "text-orange-400" : "text-gray-300"}`}>
                        {isHeavy ? "🔥 " : ""}{c.name}
                      </span>
                      <span className="text-gray-400">{c.value}</span>
                    </div>
                    <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${pct}%`,
                          background: c.color,
                          boxShadow: isHeavy ? `0 0 8px ${ORANGE_HEAVY}60` : "none",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Gargalo */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-bold text-white mb-3">⏳ Gargalo nas Etapas (parados {">"}1h)</h3>
        {gargalo.length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-3">Nenhum card parado por mais de 1h</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {gargalo.slice(0, 9).map(a => (
              <div key={a.id} className="flex items-center justify-between bg-gray-800/50 rounded-lg px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-white truncate">{a.cli || a.lic}</div>
                  <div className="text-[0.6rem] text-gray-400">{a.etapa}</div>
                </div>
                <span className="font-mono text-xs font-bold text-amber-400 ml-2">
                  {fmtTime(a.elapsed)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top Performance */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-bold text-white mb-4">🏆 Top Performance — SLA 4h</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={topPerformance}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 11 }} />
              <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} unit="%" domain={[0, 100]} />
              <Tooltip content={customTooltip} />
              <Bar dataKey="percentual" name="SLA %" radius={[4, 4, 0, 0]}>
                {topPerformance.map((entry, i) => (
                  <Cell key={i} fill={entry.percentual >= 80 ? EMERALD : entry.percentual >= 50 ? AMBER : NEON_RED} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Pie: Classificacao */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-bold text-white mb-4">📈 Distribuicao por Classificacao</h3>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={porClassificacao} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={85}
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              >
                {porClassificacao.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 10, color: "#9ca3af" }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Cards por Etapa */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 lg:col-span-2">
          <h3 className="text-sm font-bold text-white mb-4">📋 Cards por Etapa</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={porEtapa} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis type="number" tick={{ fill: "#9ca3af", fontSize: 11 }} allowDecimals={false} />
              <YAxis dataKey="name" type="category" tick={{ fill: "#9ca3af", fontSize: 11 }} width={150} />
              <Tooltip content={customTooltip} />
              <Bar dataKey="value" name="Cards" fill={BLUE_INFO} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Month info */}
      <div className="text-center text-[0.6rem] text-gray-600">
        Dados de {now.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })} (dia 1 ao {new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()})
      </div>
    </div>
  );
}
