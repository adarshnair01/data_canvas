import { useDraggable } from "@dnd-kit/core";
import { FunctionSquare, Hash, Plus } from "lucide-react";
import { TypeBadge } from "@/features/data/TypeBadge";
import { cn } from "@/lib/utils";
import { fieldRole, type DatasetMeta } from "@/types/dataset";
import type { CalculatedMetric } from "@/types/metrics";
import { dragItemId, type DragItem } from "./fieldDefaults";

function DraggableField({
  item,
  label,
  icon,
  onAdd,
}: {
  item: DragItem;
  label: string;
  icon: React.ReactNode;
  onAdd: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: dragItemId(item), data: item });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        "group flex cursor-grab items-center gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-accent active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onAdd}
        className="opacity-0 group-hover:opacity-100 hover:text-primary"
        aria-label={`Add ${label}`}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

export function FieldList({
  dataset,
  metrics,
  onAdd,
}: {
  dataset: DatasetMeta;
  metrics: CalculatedMetric[];
  onAdd: (item: DragItem) => void;
}) {
  const dims = dataset.columns.filter((c) => fieldRole(c) === "dimension");
  const measures = dataset.columns.filter((c) => fieldRole(c) === "measure");
  const own = metrics.filter((m) => m.datasetId === dataset.id);

  const section = (title: string) => (
    <div className="px-1.5 pt-3 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</div>
  );

  return (
    <div className="flex flex-col">
      {section("Dimensions")}
      {dims.map((c) => (
        <DraggableField
          key={c.name}
          item={{ kind: "column", name: c.name }}
          label={c.name}
          icon={<TypeBadge type={c.logicalType} />}
          onAdd={() => onAdd({ kind: "column", name: c.name })}
        />
      ))}
      {section("Measures")}
      <DraggableField
        item={{ kind: "rows" }}
        label="Row count"
        icon={<Hash className="size-3.5 text-emerald-600" />}
        onAdd={() => onAdd({ kind: "rows" })}
      />
      {measures.map((c) => (
        <DraggableField
          key={c.name}
          item={{ kind: "column", name: c.name }}
          label={c.name}
          icon={<TypeBadge type={c.logicalType} />}
          onAdd={() => onAdd({ kind: "column", name: c.name })}
        />
      ))}
      {own.length > 0 && section("Calculated")}
      {own.map((m) => (
        <DraggableField
          key={m.id}
          item={{ kind: "metric", id: m.id }}
          label={m.name}
          icon={<FunctionSquare className="size-3.5 text-violet-600" />}
          onAdd={() => onAdd({ kind: "metric", id: m.id })}
        />
      ))}
    </div>
  );
}
