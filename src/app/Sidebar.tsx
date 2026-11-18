import { Database, Globe, Home, LayoutDashboard, Upload } from "lucide-react";
import { motion } from "motion/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDashboard } from "@/features/dashboard/store";
import { setStorageMode } from "@/features/project/actions";
import { useProject } from "@/features/project/store";
import { shortcutLabel } from "@/lib/platform";
import { capabilities } from "@/lib/target";
import { cn } from "@/lib/utils";
import { useUi, type Route } from "./uiStore";

const NAV: { route: Route; label: string; icon: typeof Home; key: string }[] = [
  { route: "home", label: "Home", icon: Home, key: "mod+1" },
  { route: "data", label: "Data", icon: Database, key: "mod+2" },
  { route: "dashboard", label: "Dashboard", icon: LayoutDashboard, key: "mod+3" },
];

/** Web build: where the data lives and what the browser version cannot do. */
function WebModeBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="mt-2 flex items-center gap-1.5 rounded-md border bg-accent/50 px-2 py-1 text-[11px] text-accent-foreground"
          aria-label="Web version"
        >
          <Globe className="size-3.5 text-primary" />
          <span className="font-medium">Web</span>
          <span className="text-muted-foreground">· runs in your browser</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        Files are read by DuckDB inside this tab and never uploaded. Projects are always saved as Portable (data
        embedded). No recent-projects list or native menus; very large files are limited by browser memory.
      </TooltipContent>
    </Tooltip>
  );
}

export function Sidebar() {
  const route = useUi((s) => s.route);
  const navigate = useUi((s) => s.navigate);
  const openImport = useUi((s) => s.openImport);
  const projectName = useDashboard((s) => s.doc.name);
  const dirty = useDashboard((s) => s.dirty);
  const projectPath = useProject((s) => s.path);
  const mode = useProject((s) => s.mode);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar">
      <div className="flex h-12 items-center gap-2 px-4">
        <div className="bg-brand flex size-6 items-center justify-center rounded-md text-[11px] font-bold shadow-sm">
          DC
        </div>
        <span className="font-semibold tracking-tight">DataCanvas</span>
      </div>
      <div className="px-4 pb-3">
        <div className="truncate text-xs text-muted-foreground" title={projectPath ?? projectName}>
          {projectName}
          {dirty && <span className="ml-1 text-primary">●</span>}
        </div>
        {capabilities.linkedStorage ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="mt-2 flex rounded-md border p-0.5 text-[11px]" role="radiogroup" aria-label="Project storage">
                {(["linked", "portable"] as const).map((m) => (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setStorageMode(m)}
                    className={cn(
                      "flex-1 rounded px-2 py-0.5 capitalize",
                      mode === m ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-56">
              Linked saves paths to your data files. Portable also embeds a copy of the data, so the project opens anywhere.
            </TooltipContent>
          </Tooltip>
        ) : (
          <WebModeBadge />
        )}
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        {NAV.map(({ route: r, label, icon: Icon, key }) => (
          <Tooltip key={r}>
            <TooltipTrigger asChild>
              <button
                onClick={() => navigate(r)}
                aria-current={route === r ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                  route === r ? "font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                {route === r && (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-md bg-accent"
                    transition={{ type: "spring", stiffness: 500, damping: 38 }}
                  />
                )}
                <Icon className="relative size-4" />
                <span className="relative">{label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{shortcutLabel(key)}</TooltipContent>
          </Tooltip>
        ))}
      </nav>
      <div className="mt-auto p-3">
        <button
          onClick={() => openImport()}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:border-primary hover:text-foreground"
        >
          <Upload className="size-3.5" />
          Import data ({shortcutLabel("mod+i")})
        </button>
      </div>
    </aside>
  );
}
