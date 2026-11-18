import { Binary, Calendar, CalendarClock, Hash, Type, ToggleLeft, Percent } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LogicalType } from "@/types/dataset";

const ICONS: Record<LogicalType, typeof Hash> = {
  string: Type,
  integer: Hash,
  float: Percent,
  boolean: ToggleLeft,
  date: Calendar,
  timestamp: CalendarClock,
  other: Binary,
};

const COLORS: Record<LogicalType, string> = {
  string: "text-sky-600",
  integer: "text-emerald-600",
  float: "text-emerald-600",
  boolean: "text-violet-600",
  date: "text-amber-600",
  timestamp: "text-amber-600",
  other: "text-muted-foreground",
};

export const TYPE_LABELS: Record<LogicalType, string> = {
  string: "Text",
  integer: "Integer",
  float: "Decimal",
  boolean: "Boolean",
  date: "Date",
  timestamp: "Date & time",
  other: "Other",
};

export function TypeBadge({ type, className }: { type: LogicalType; className?: string }) {
  const Icon = ICONS[type];
  return <Icon className={cn("size-3.5 shrink-0", COLORS[type], className)} aria-label={TYPE_LABELS[type]} />;
}
