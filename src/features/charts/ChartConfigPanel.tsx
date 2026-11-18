import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDashboard } from "@/features/dashboard/store";
import { cn } from "@/lib/utils";
import { PALETTES, type ChartConfig, type LegendPosition, type PaletteName } from "@/types/chart";
import type { Widget } from "@/types/project";

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {label}
    </label>
  );
}

export function ChartConfigPanel({ widget }: { widget: Widget }) {
  const update = (patch: Partial<ChartConfig>) => useDashboard.getState().updateConfig(widget.id, patch);
  const c = widget.config;
  const t = widget.chartType;
  const cartesian = t === "bar" || t === "line" || t === "area" || t === "scatter";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-1.5">
        <Label className="text-xs">Title</Label>
        <Input className="h-8 text-xs" value={c.title} onChange={(e) => update({ title: e.target.value })} placeholder="Untitled chart" />
        <Toggle label="Show title" checked={c.showTitle} onChange={(showTitle) => update({ showTitle })} />
      </div>

      {t !== "kpi" && t !== "table" && (
        <div className="grid gap-1.5">
          <Label className="text-xs">Legend</Label>
          <div className="flex items-center gap-2">
            <Toggle label="Show" checked={c.legend.show} onChange={(show) => update({ legend: { ...c.legend, show } })} />
            <Select value={c.legend.position} onValueChange={(v) => update({ legend: { ...c.legend, position: v as LegendPosition } })}>
              <SelectTrigger size="sm" className="ml-auto h-7 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["top", "bottom", "left", "right"] as const).map((p) => (
                  <SelectItem key={p} value={p} className="text-xs capitalize">
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {cartesian && (
        <div className="grid gap-1.5">
          <Label className="text-xs">Axes</Label>
          <Input className="h-7 text-xs" placeholder="X axis title" value={c.xAxis.title} onChange={(e) => update({ xAxis: { ...c.xAxis, title: e.target.value } })} />
          <Input className="h-7 text-xs" placeholder="Y axis title" value={c.yAxis.title} onChange={(e) => update({ yAxis: { ...c.yAxis, title: e.target.value } })} />
          <div className="flex gap-4">
            <Toggle label="X labels" checked={c.xAxis.showLabels} onChange={(showLabels) => update({ xAxis: { ...c.xAxis, showLabels } })} />
            <Toggle label="Y labels" checked={c.yAxis.showLabels} onChange={(showLabels) => update({ yAxis: { ...c.yAxis, showLabels } })} />
          </div>
        </div>
      )}

      {t !== "kpi" && t !== "table" && (
        <div className="grid gap-1.5">
          <Label className="text-xs">Palette</Label>
          <div className="grid gap-1">
            {(Object.keys(PALETTES) as PaletteName[]).map((p) => (
              <button
                key={p}
                onClick={() => update({ palette: p })}
                className={cn("flex items-center gap-2 rounded border px-2 py-1 text-xs capitalize", c.palette === p ? "border-primary bg-primary/5" : "hover:bg-accent")}
              >
                <span className="flex">
                  {PALETTES[p].slice(0, 6).map((color) => (
                    <span key={color} className="size-3" style={{ background: color }} />
                  ))}
                </span>
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-1.5">
        {(t === "bar" || t === "line" || t === "area") && (
          <>
            <Label className="text-xs">Options</Label>
            <Toggle label="Stacked" checked={c.stacked} onChange={(stacked) => update({ stacked })} />
          </>
        )}
        {t === "bar" && <Toggle label="Horizontal bars" checked={c.horizontal} onChange={(horizontal) => update({ horizontal })} />}
        {(t === "line" || t === "area") && <Toggle label="Smooth lines" checked={c.smooth} onChange={(smooth) => update({ smooth })} />}
        {t === "pie" && <Toggle label="Donut" checked={c.donut} onChange={(donut) => update({ donut })} />}
        {(t === "bar" || t === "line" || t === "area" || t === "pie") && (
          <Toggle label="Data labels" checked={c.showDataLabels} onChange={(showDataLabels) => update({ showDataLabels })} />
        )}
      </div>

      {t === "kpi" && (
        <div className="grid grid-cols-3 gap-2">
          <div className="grid gap-1">
            <Label className="text-xs">Prefix</Label>
            <Input className="h-7 text-xs" value={c.kpi.prefix} onChange={(e) => update({ kpi: { ...c.kpi, prefix: e.target.value } })} />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Suffix</Label>
            <Input className="h-7 text-xs" value={c.kpi.suffix} onChange={(e) => update({ kpi: { ...c.kpi, suffix: e.target.value } })} />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Decimals</Label>
            <Input
              className="h-7 text-xs"
              type="number"
              min={0}
              max={6}
              value={c.kpi.decimals}
              onChange={(e) => update({ kpi: { ...c.kpi, decimals: Math.max(0, Math.min(6, Number(e.target.value) || 0)) } })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
