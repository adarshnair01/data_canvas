import { useEffect } from "react";
import { FileDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ExportProgress } from "@/components/ExportProgress";
import { Toaster } from "@/components/Toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MetricsDialog } from "@/features/dashboard/MetricsDialog";
import { useDashboard } from "@/features/dashboard/store";
import { ImportDialog } from "@/features/data/ImportDialog";
import { useData } from "@/features/data/store";
import {
  checkRecovery,
  openFilesFromOs,
  openLaunchFiles,
  requestQuit,
  startAutosave,
} from "@/features/project/actions";
import { ProjectIssuesDialog } from "@/features/project/ProjectIssuesDialog";
import { RecoveryDialog } from "@/features/project/RecoveryDialog";
import {
  listenFileDrops,
  listenMenu,
  listenOpenFiles,
  listenPageLeave,
  listenQuitRequests,
} from "@/lib/nativeEvents";
import { errorMessage } from "@/types/errors";
import { handleDroppedPaths, handleMenuAction } from "./actions";
import { DashboardScreen } from "./DashboardScreen";
import { DataScreen } from "./DataScreen";
import { HomeScreen } from "./HomeScreen";
import { Sidebar } from "./Sidebar";
import { toast, useUi } from "./uiStore";

const SCREENS = { home: HomeScreen, data: DataScreen, dashboard: DashboardScreen };

export default function App() {
  const route = useUi((s) => s.route);
  const dragOver = useUi((s) => s.dragOver);
  const Screen = SCREENS[route];

  useEffect(() => {
    useData
      .getState()
      .refresh()
      .catch((e) => toast({ tone: "error", title: "Could not load datasets", description: errorMessage(e) }));
    void checkRecovery();
    void openLaunchFiles();
    const stopAutosave = startAutosave();
    const offQuit = listenQuitRequests(() => void requestQuit());
    const offLeave = listenPageLeave(() => useDashboard.getState().dirty);
    const offOpen = listenOpenFiles((paths) => void openFilesFromOs(paths));
    const offMenu = listenMenu(handleMenuAction);
    const offDrop = listenFileDrops(handleDroppedPaths, (s) => useUi.getState().setDragOver(s === "over"));
    return () => {
      stopAutosave();
      offQuit();
      offLeave();
      offOpen();
      offMenu();
      offDrop();
    };
  }, []);

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full overflow-hidden">
        <Sidebar />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={route}
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <Screen />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <AnimatePresence>
        {dragOver && (
          <motion.div
            className="pointer-events-none fixed inset-0 z-[90] flex items-center justify-center bg-primary/10 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <motion.div
              className="glass flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-primary px-10 py-8 shadow-xl"
              initial={{ scale: 0.92 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 380, damping: 22 }}
            >
              <motion.div
                animate={{ y: [0, -5, 0] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
              >
                <FileDown className="size-8 text-primary" />
              </motion.div>
              <div className="font-medium">Drop to import</div>
              <div className="text-xs text-muted-foreground">CSV, Excel or .datacanvas</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <ImportDialog />
      <MetricsDialog />
      <ProjectIssuesDialog />
      <RecoveryDialog />
      <ConfirmDialog />
      <ExportProgress />
      <Toaster />
    </TooltipProvider>
  );
}
