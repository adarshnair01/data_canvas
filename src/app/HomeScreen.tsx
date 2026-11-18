import { useEffect, useId, useRef, useState } from "react";
import { Clock, FilePlus2, FolderOpen, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { newProject, openProject } from "@/features/project/actions";
import { useData } from "@/features/data/store";
import { ipc, type RecentProject } from "@/lib/ipc";
import { useStaggerIn } from "@/lib/motion";
import { shortcutLabel } from "@/lib/platform";
import { capabilities, IS_WEB } from "@/lib/target";
import { errorMessage } from "@/types/errors";
import { toast, useUi } from "./uiStore";

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** Film grain from an SVG turbulence filter (no image assets, no extra library). */
function Grain() {
  const id = useId().replace(/:/g, "");
  return (
    <svg className="pointer-events-none absolute inset-0 size-full opacity-[0.07] mix-blend-multiply [mask-image:linear-gradient(to_bottom,#000_55%,transparent)] dark:opacity-[0.12] dark:mix-blend-screen" aria-hidden>
      <filter id={`grain-${id}`}>
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter={`url(#grain-${id})`} />
    </svg>
  );
}

const BARS = [0.42, 0.68, 0.5, 0.86, 0.64, 0.95];

/** Decorative chart that builds itself once: bars rise in sequence, then the trend line draws. */
function HeroChart() {
  const reduced = useReducedMotion();
  const w = 168;
  const h = 96;
  const bw = 18;
  const gap = (w - BARS.length * bw) / (BARS.length - 1);
  const points = BARS.map((v, i) => [i * (bw + gap) + bw / 2, h - v * h * 0.85 - 6] as const);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-24 w-44 shrink-0 overflow-visible" aria-hidden>
      <defs>
        <linearGradient id="hero-bar" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--brand-2)" />
          <stop offset="1" stopColor="var(--brand-1)" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      {BARS.map((v, i) => (
        <motion.rect
          key={i}
          x={i * (bw + gap)}
          width={bw}
          rx={4}
          fill="url(#hero-bar)"
          initial={reduced ? false : { height: 0, y: h }}
          animate={{ height: v * h * 0.85, y: h - v * h * 0.85 }}
          transition={{ type: "spring", stiffness: 160, damping: 18, delay: 0.15 + i * 0.07 }}
        />
      ))}
      <motion.path
        d={line}
        fill="none"
        stroke="var(--brand-3)"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={reduced ? false : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.9, delay: 0.7, ease: "easeInOut" }}
      />
    </svg>
  );
}

export function HomeScreen() {
  const [recent, setRecent] = useState<RecentProject[] | null>(capabilities.recentProjects ? null : []);
  const openImport = useUi((s) => s.openImport);
  const navigate = useUi((s) => s.navigate);
  const datasets = useData((s) => s.datasets);
  const root = useRef<HTMLDivElement>(null);

  useStaggerIn(root, "[data-stagger]", null, { step: 55, start: 80 });

  useEffect(() => {
    if (!capabilities.recentProjects) return;
    ipc
      .listRecentProjects()
      .then(setRecent)
      .catch((e) => {
        setRecent([]);
        toast({ tone: "error", title: "Could not load recent projects", description: errorMessage(e) });
      });
  }, []);

  const remove = async (path: string) => setRecent(await ipc.removeRecentProject(path));
  const clear = async () => {
    await ipc.clearRecentProjects();
    setRecent([]);
  };

  const actions = [
    { icon: FilePlus2, title: "New project", hint: shortcutLabel("mod+n"), onClick: () => void newProject() },
    { icon: FolderOpen, title: "Open project…", hint: shortcutLabel("mod+o"), onClick: () => void openProject() },
    { icon: Upload, title: "Import data…", hint: shortcutLabel("mod+i"), onClick: () => openImport() },
  ];

  return (
    <div className="flex-1 overflow-auto" ref={root}>
      <section className="hero-mesh relative overflow-hidden">
        <Grain />
        <div className="relative mx-auto flex max-w-4xl items-center justify-between gap-8 px-8 pt-12 pb-10">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Welcome to <span className="text-brand">DataCanvas</span>
            </h1>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              {IS_WEB
                ? "Build dashboards from CSV and Excel files, right in your browser. Files are processed on this device and never uploaded."
                : "Build dashboards from CSV and Excel files. Everything stays on this computer."}
            </p>
          </div>
          <HeroChart />
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-8 pb-10">
        <div className="-mt-6 grid grid-cols-3 gap-3">
          {actions.map(({ icon: Icon, title, hint, onClick }) => (
            <button
              key={title}
              data-stagger
              onClick={onClick}
              className="glass group relative flex flex-col items-start gap-3 rounded-xl border p-4 text-left shadow-sm transition-[box-shadow,border-color,translate] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <div className="bg-brand flex size-9 items-center justify-center rounded-lg shadow-sm transition-transform duration-200 group-hover:scale-105">
                <Icon className="size-4.5" />
              </div>
              <div className="flex w-full items-center justify-between">
                <span className="font-medium">{title}</span>
                <kbd className="text-xs text-muted-foreground">{hint}</kbd>
              </div>
            </button>
          ))}
        </div>

        {capabilities.recentProjects ? (
          <>
            <div className="mt-10 flex items-center justify-between" data-stagger>
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Clock className="size-4 text-muted-foreground" /> Recent projects
              </h2>
              {!!recent?.length && (
                <Button variant="ghost" size="xs" onClick={clear}>
                  <Trash2 /> Clear
                </Button>
              )}
            </div>
            <div className="mt-3 overflow-hidden rounded-xl border bg-card" data-stagger>
              {recent === null && <div className="p-6 text-sm text-muted-foreground">Loading…</div>}
              {recent?.length === 0 && (
                <div className="p-6 text-sm text-muted-foreground">
                  No recent projects. Projects you open or save will appear here.
                </div>
              )}
              {recent?.map((p) => (
                <div key={p.path} className="group flex items-center gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-accent/40">
                  <button className="min-w-0 flex-1 text-left" onClick={() => void openProject(p.path)}>
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="truncate text-xs text-muted-foreground" data-selectable>
                      {p.path}
                    </div>
                  </button>
                  <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(p.lastOpenedMs)}</span>
                  <button
                    className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                    onClick={() => void remove(p.path)}
                    aria-label="Remove from recent"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="mt-10 flex gap-3 rounded-xl border bg-card p-4 text-sm" data-stagger>
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
            <div>
              <div className="font-medium">Private by design</div>
              <p className="mt-1 text-muted-foreground">
                DuckDB runs inside this tab, so your files never leave your device. Save projects to keep your work;
                unsaved changes are also autosaved in this browser for recovery. Very large files are limited by browser
                memory, so the desktop app suits files over a few hundred MB.
              </p>
            </div>
          </div>
        )}

        {datasets.length > 0 && (
          <div className="mt-10" data-stagger>
            <h2 className="text-sm font-semibold">Datasets in this session</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {datasets.map((d) => (
                <button
                  key={d.id}
                  onClick={() => {
                    useData.getState().select(d.id);
                    navigate("data");
                  }}
                  className="rounded-lg border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary/50"
                >
                  <div className="font-medium">{d.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {d.rowCount.toLocaleString()} rows · {d.columns.length} columns
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="mt-10 text-center text-xs text-muted-foreground">
          Tip: drag a CSV, Excel or .datacanvas file anywhere onto this {IS_WEB ? "page" : "window"}.
        </p>
      </div>
    </div>
  );
}
