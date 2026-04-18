import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Activity,
  Clock,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { format, subDays, startOfDay } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";

interface QueryRow {
  id: string;
  session_id: string;
  question: string;
  answer: string | null;
  response_time_ms: number | null;
  success: boolean;
  error_code: string | null;
  source_categories: string[];
  source_count: number;
  top_score: number | null;
  created_at: string;
}

interface FeedbackRow {
  id: string;
  query_id: string | null;
  rating: "up" | "down";
  created_at: string;
}

const RANGE_OPTIONS = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
] as const;

export default function Admin() {
  const [days, setDays] = useState<number>(7);
  const [queries, setQueries] = useState<QueryRow[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const since = subDays(new Date(), days).toISOString();
    try {
      const [q, f] = await Promise.all([
        supabase
          .from("queries")
          .select("*")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(1000),
        supabase
          .from("query_feedback")
          .select("*")
          .gte("created_at", since)
          .limit(1000),
      ]);
      if (q.error) throw q.error;
      if (f.error) throw f.error;
      setQueries((q.data ?? []) as QueryRow[]);
      setFeedback((f.data ?? []) as FeedbackRow[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  // ---- Aggregates ----
  const stats = useMemo(() => {
    const total = queries.length;
    const failed = queries.filter((q) => !q.success).length;
    const successRate = total ? ((total - failed) / total) * 100 : 0;
    const validLatencies = queries
      .filter((q) => q.response_time_ms != null)
      .map((q) => q.response_time_ms as number);
    const avgLatency = validLatencies.length
      ? validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length
      : 0;
    const sortedLat = [...validLatencies].sort((a, b) => a - b);
    const p95 = sortedLat.length
      ? sortedLat[Math.floor(sortedLat.length * 0.95)] ?? sortedLat[sortedLat.length - 1]
      : 0;
    const ups = feedback.filter((f) => f.rating === "up").length;
    const downs = feedback.filter((f) => f.rating === "down").length;
    return { total, failed, successRate, avgLatency, p95, ups, downs };
  }, [queries, feedback]);

  const volumeByDay = useMemo(() => {
    const buckets = new Map<string, { date: string; total: number; failed: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = startOfDay(subDays(new Date(), i));
      const key = format(d, "MMM d");
      buckets.set(key, { date: key, total: 0, failed: 0 });
    }
    queries.forEach((q) => {
      const key = format(startOfDay(new Date(q.created_at)), "MMM d");
      const b = buckets.get(key);
      if (b) {
        b.total += 1;
        if (!q.success) b.failed += 1;
      }
    });
    return Array.from(buckets.values());
  }, [queries, days]);

  const latencyByDay = useMemo(() => {
    const buckets = new Map<string, { date: string; sum: number; count: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = startOfDay(subDays(new Date(), i));
      const key = format(d, "MMM d");
      buckets.set(key, { date: key, sum: 0, count: 0 });
    }
    queries.forEach((q) => {
      if (q.response_time_ms == null) return;
      const key = format(startOfDay(new Date(q.created_at)), "MMM d");
      const b = buckets.get(key);
      if (b) {
        b.sum += q.response_time_ms;
        b.count += 1;
      }
    });
    return Array.from(buckets.values()).map((b) => ({
      date: b.date,
      avg: b.count ? Math.round(b.sum / b.count) : 0,
    }));
  }, [queries, days]);

  const topFailedQuestions = useMemo(() => {
    const counts = new Map<string, number>();
    queries
      .filter((q) => !q.success)
      .forEach((q) => {
        const k = q.question.toLowerCase().trim().slice(0, 120);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([question, count]) => ({ question, count }));
  }, [queries]);

  const errorBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    queries
      .filter((q) => !q.success)
      .forEach((q) => {
        const k = q.error_code ?? "unknown";
        counts.set(k, (counts.get(k) ?? 0) + 1);
      });
    return Array.from(counts.entries()).map(([code, count]) => ({ code, count }));
  }, [queries]);

  return (
    <div className="min-h-screen adinkra-bg">
      {/* Header */}
      <div className="glass-strong border-b border-border/50 sticky top-0 z-10">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="p-2 rounded-lg hover:bg-muted transition-colors"
              aria-label="Back to chat"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div>
              <h1 className="font-accent text-xl sm:text-2xl">
                <span className="ghana-gradient-text font-bold">Analytics</span>
              </h1>
              <p className="text-xs text-muted-foreground">
                Usage, latency, and feedback for the RAG assistant
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-border overflow-hidden">
              {RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => setDays(opt.days)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    days === opt.days
                      ? "bg-ghana-gold/20 text-foreground"
                      : "hover:bg-muted text-muted-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              onClick={load}
              disabled={loading}
              className="p-2 rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-screen-2xl mx-auto px-4 py-6 space-y-6">
        {error && (
          <Card className="border-ghana-red/40 bg-ghana-red/5">
            <CardContent className="p-4 text-sm text-ghana-red">
              Failed to load analytics: {error}
            </CardContent>
          </Card>
        )}

        {/* KPI cards */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3"
        >
          <KpiCard
            icon={<MessageSquare className="w-4 h-4" />}
            label="Queries"
            value={loading ? null : stats.total.toLocaleString()}
            tone="indigo"
          />
          <KpiCard
            icon={<Activity className="w-4 h-4" />}
            label="Success rate"
            value={loading ? null : `${stats.successRate.toFixed(1)}%`}
            tone="green"
          />
          <KpiCard
            icon={<Clock className="w-4 h-4" />}
            label="Avg latency"
            value={loading ? null : `${(stats.avgLatency / 1000).toFixed(2)}s`}
            tone="gold"
          />
          <KpiCard
            icon={<Clock className="w-4 h-4" />}
            label="P95 latency"
            value={loading ? null : `${(stats.p95 / 1000).toFixed(2)}s`}
            tone="gold"
          />
          <KpiCard
            icon={<ThumbsUp className="w-4 h-4" />}
            label="Thumbs up"
            value={loading ? null : stats.ups.toLocaleString()}
            tone="green"
          />
          <KpiCard
            icon={<ThumbsDown className="w-4 h-4" />}
            label="Thumbs down"
            value={loading ? null : stats.downs.toLocaleString()}
            tone="red"
          />
        </motion.div>

        {/* Charts */}
        <div className="grid lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Query volume</CardTitle>
            </CardHeader>
            <CardContent className="h-64">
              {loading ? (
                <Skeleton className="w-full h-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={volumeByDay}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="total" fill="hsl(var(--ghana-gold))" radius={[6, 6, 0, 0]} />
                    <Bar dataKey="failed" fill="hsl(var(--ghana-red))" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Average latency (ms)</CardTitle>
            </CardHeader>
            <CardContent className="h-64">
              {loading ? (
                <Skeleton className="w-full h-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={latencyByDay}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="avg"
                      stroke="hsl(var(--ghana-green))"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Tabs: failures + recent */}
        <Tabs defaultValue="failures">
          <TabsList>
            <TabsTrigger value="failures">Top failed questions</TabsTrigger>
            <TabsTrigger value="errors">Error breakdown</TabsTrigger>
            <TabsTrigger value="recent">Recent queries</TabsTrigger>
          </TabsList>

          <TabsContent value="failures">
            <Card>
              <CardContent className="p-4">
                {loading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-8 w-full" />
                    ))}
                  </div>
                ) : topFailedQuestions.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-8 text-center">
                    🎉 No failed queries in the selected window.
                  </div>
                ) : (
                  <ul className="divide-y divide-border/50">
                    {topFailedQuestions.map((row) => (
                      <li
                        key={row.question}
                        className="py-2 flex items-center justify-between gap-4"
                      >
                        <span className="text-sm truncate flex-1">{row.question}</span>
                        <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-ghana-red/10 text-ghana-red border border-ghana-red/20 shrink-0">
                          {row.count}× failed
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="errors">
            <Card>
              <CardContent className="p-4 h-64">
                {loading ? (
                  <Skeleton className="w-full h-full" />
                ) : errorBreakdown.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-8 text-center">
                    No errors in this window.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={errorBreakdown} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                      <YAxis dataKey="code" type="category" tick={{ fontSize: 10 }} width={120} />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                      />
                      <Bar dataKey="count" radius={[0, 6, 6, 0]}>
                        {errorBreakdown.map((_, i) => (
                          <Cell key={i} fill="hsl(var(--ghana-red))" />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="recent">
            <Card>
              <CardContent className="p-0 overflow-hidden">
                {loading ? (
                  <div className="p-4 space-y-2">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Skeleton key={i} className="h-10 w-full" />
                    ))}
                  </div>
                ) : queries.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-12 text-center">
                    No queries yet. Ask something on the chat page!
                  </div>
                ) : (
                  <div className="max-h-[420px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card/95 backdrop-blur border-b border-border">
                        <tr className="text-left text-muted-foreground">
                          <th className="px-3 py-2 font-medium">When</th>
                          <th className="px-3 py-2 font-medium">Question</th>
                          <th className="px-3 py-2 font-medium text-right">Latency</th>
                          <th className="px-3 py-2 font-medium text-center">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {queries.slice(0, 100).map((q) => (
                          <tr key={q.id} className="border-b border-border/40 hover:bg-muted/40">
                            <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                              {format(new Date(q.created_at), "MMM d, HH:mm")}
                            </td>
                            <td className="px-3 py-2 max-w-md truncate" title={q.question}>
                              {q.question}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                              {q.response_time_ms != null
                                ? `${(q.response_time_ms / 1000).toFixed(2)}s`
                                : "—"}
                            </td>
                            <td className="px-3 py-2 text-center">
                              {q.success ? (
                                <span className="px-2 py-0.5 rounded-full bg-ghana-green/10 text-ghana-green border border-ghana-green/20">
                                  ok
                                </span>
                              ) : (
                                <span
                                  className="px-2 py-0.5 rounded-full bg-ghana-red/10 text-ghana-red border border-ghana-red/20 inline-flex items-center gap-1"
                                  title={q.error_code ?? "error"}
                                >
                                  <AlertTriangle className="w-3 h-3" />
                                  {q.error_code ?? "error"}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  tone: "indigo" | "green" | "gold" | "red";
}

function KpiCard({ icon, label, value, tone }: KpiCardProps) {
  const toneClasses = {
    indigo: "text-adinkra-indigo border-adinkra-indigo/20 bg-adinkra-indigo/5",
    green: "text-ghana-green border-ghana-green/20 bg-ghana-green/5",
    gold: "text-ghana-gold border-ghana-gold/20 bg-ghana-gold/5",
    red: "text-ghana-red border-ghana-red/20 bg-ghana-red/5",
  }[tone];

  return (
    <Card className={`border ${toneClasses}`}>
      <CardContent className="p-3 flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-xs font-medium opacity-80">
          {icon}
          {label}
        </div>
        {value === null ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <div className="text-2xl font-bold text-foreground tabular-nums">{value}</div>
        )}
      </CardContent>
    </Card>
  );
}
