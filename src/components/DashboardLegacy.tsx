import { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line, Area, AreaChart,
} from "recharts";
import type { Atendimento } from "./AttendanceCard";

const COLORS = ["hsl(var(--primary))", "hsl(var(--accent))", "hsl(var(--destructive))", "hsl(var(--vintage-blue))", "hsl(var(--vintage-green))", "hsl(var(--vintage-yellow))", "hsl(var(--vintage-sage))"];

const CLAS_COLORS: Record<string, string> = {
  NFe: "#2563eb", "NFe SC": "#7c3aed", "Boleto Fácil": "#0891b2",
  "Boleto Tradicional": "#0369a1", TEF: "#15803d", Impressora: "#ea580c", Etiqueta: "#d97706",
};

interface Props {
  data: Atendimento[];
  now: Date;
}

export default function Dashboard({ data, now }: Props) {
  const active = useMemo(() => data.filter(a => a && !a.encerrado), [data]);

  // Cards por analista
  const porAnalista = useMemo(() => {
    const map: Record<string, { total: number; alta: number; media: number }> = {};
    active.forEach(a => {
      const name = a.analista || "Sem analista";
      if (!map[name]) map[name] = { total: 0, alta: 0, media: 0 };
      map[name].total++;
      if (a.dem === "Alta") map[name].alta++;
      else map[name].media++;
    });
    return Object.entries(map).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.total - a.total);
  }, [active]);

  // Cards por classificação
  const porClassificacao = useMemo(() => {
    const map: Record<string, number> = {};
    active.forEach(a => {
      const c = a.clas || "Outros";
      map[c] = (map[c] || 0) + 1;
    });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [active]);

  // Cards por etapa
  const porEtapa = useMemo(() => {
    const map: Record<string, number> = {};
    active.forEach(a => {
      const e = a.etapa || "Desconhecido";
      map[e] = (map[e] || 0) + 1;
    });
    return Object.entries(map).map(([name, value]) => ({ name: name.length > 18 ? name.slice(0, 16) + "…" : name, value })).sort((a, b) => b.value - a.value);
  }, [active]);

  // Tempo médio aberto por analista (em horas)
  const tempoMedio = useMemo(() => {
    const map: Record<string, { sum: number; count: number }> = {};
    active.forEach(a => {
      const name = a.analista || "Sem analista";
      const elapsed = now.getTime() - (a.abertoEm || now.getTime());
      if (!map[name]) map[name] = { sum: 0, count: 0 };
      map[name].sum += elapsed;
      map[name].count++;
    });
    return Object.entries(map).map(([name, v]) => ({
      name,
      horas: Math.round((v.sum / v.count / 3600000) * 10) / 10,
    })).sort((a, b) => b.horas - a.horas);
  }, [active, now]);

  // SLA: % dentro do prazo por analista
  const sla = useMemo(() => {
    const LIM = 4 * 3600000;
    const map: Record<string, { ok: number; total: number }> = {};
    active.forEach(a => {
      const name = a.analista || "Sem analista";
      const elapsed = now.getTime() - (a.abertoEm || now.getTime());
      if (!map[name]) map[name] = { ok: 0, total: 0 };
      map[name].total++;
      if (elapsed <= LIM) map[name].ok++;
    });
    return Object.entries(map).map(([name, v]) => ({
      name,
      percentual: Math.round((v.ok / v.total) * 100),
      total: v.total,
    })).sort((a, b) => a.percentual - b.percentual);
  }, [active, now]);

  const customTooltip = ({ active: a, payload, label }: any) => {
    if (!a || !payload?.length) return null;
    return (
      <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-lg text-xs">
        <p className="font-bold text-foreground mb-1">{label}</p>
        {payload.map((p: any, i: number) => (
          <p key={i} style={{ color: p.color }} className="font-medium">{p.name}: {p.value}</p>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Summary row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <div className="text-[0.65rem] uppercase font-bold text-muted-foreground">Total Abertos</div>
          <div className="text-3xl font-extrabold text-foreground">{active.length}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <div className="text-[0.65rem] uppercase font-bold text-muted-foreground">Analistas Ativos</div>
          <div className="text-3xl font-extrabold text-foreground">{porAnalista.length}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <div className="text-[0.65rem] uppercase font-bold text-muted-foreground">Alta Demanda</div>
          <div className="text-3xl font-extrabold text-destructive">{active.filter(a => a.dem === "Alta").length}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <div className="text-[0.65rem] uppercase font-bold text-muted-foreground">Classificações</div>
          <div className="text-3xl font-extrabold text-accent">{porClassificacao.length}</div>
        </div>
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Bar: Cards por Analista */}
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-bold text-foreground mb-4">📊 Cards por Analista</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={porAnalista} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} allowDecimals={false} />
              <Tooltip content={customTooltip} />
              <Bar dataKey="alta" name="Alta" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} stackId="a" />
              <Bar dataKey="media" name="Média" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} stackId="a" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Pie: Por Classificação */}
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-bold text-foreground mb-4">🏷️ Distribuição por Classificação</h3>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={porClassificacao} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                {porClassificacao.map((entry, i) => (
                  <Cell key={i} fill={CLAS_COLORS[entry.name] || COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Bar: Tempo Médio por Analista */}
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-bold text-foreground mb-4">⏱️ Tempo Médio Aberto (horas)</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={tempoMedio}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} unit="h" />
              <Tooltip content={customTooltip} />
              <Bar dataKey="horas" name="Horas" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Bar: SLA por Analista */}
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="text-sm font-bold text-foreground mb-4">✅ SLA 4h — % Dentro do Prazo</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={sla}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
              <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} unit="%" domain={[0, 100]} />
              <Tooltip content={customTooltip} />
              <Bar dataKey="percentual" name="SLA %" fill="hsl(var(--vintage-green))" radius={[4, 4, 0, 0]}>
                {sla.map((entry, i) => (
                  <Cell key={i} fill={entry.percentual >= 80 ? "hsl(var(--vintage-green))" : entry.percentual >= 50 ? "hsl(var(--vintage-yellow))" : "hsl(var(--destructive))"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Horizontal Bar: Por Etapa */}
        <div className="bg-card border border-border rounded-xl p-5 lg:col-span-2">
          <h3 className="text-sm font-bold text-foreground mb-4">📋 Cards por Etapa</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={porEtapa} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis type="number" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} allowDecimals={false} />
              <YAxis dataKey="name" type="category" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} width={140} />
              <Tooltip content={customTooltip} />
              <Bar dataKey="value" name="Cards" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
