import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { motion, type Variants } from "motion/react";
import { cn } from "@/lib/utils";

const container: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 320, damping: 26 } },
};

/** Icon in a softly glowing gradient halo, with title, hint and an action, revealed in sequence. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      className={cn("flex flex-col items-center justify-center gap-3 text-center", className)}
      variants={container}
      initial="hidden"
      animate="shown"
    >
      <motion.div variants={item} className="relative mb-1 flex size-20 items-center justify-center">
        <motion.div
          aria-hidden
          className="bg-brand absolute inset-0 rounded-full opacity-20 blur-xl"
          animate={{ scale: [1, 1.12, 1], opacity: [0.18, 0.3, 0.18] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        />
        <div className="glass relative flex size-16 items-center justify-center rounded-2xl border shadow-sm">
          <motion.div animate={{ y: [0, -3, 0] }} transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}>
            <Icon className="size-7 text-primary" />
          </motion.div>
        </div>
      </motion.div>
      <motion.div variants={item} className="font-medium">
        {title}
      </motion.div>
      {children && (
        <motion.p variants={item} className="max-w-sm text-sm text-muted-foreground">
          {children}
        </motion.p>
      )}
      {action && <motion.div variants={item}>{action}</motion.div>}
    </motion.div>
  );
}
