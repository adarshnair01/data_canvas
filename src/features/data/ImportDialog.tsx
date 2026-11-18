import { useEffect, useState } from "react";
import { AlertTriangle, FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { toast, useUi } from "@/app/uiStore";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { describePath } from "@/lib/backend/webFiles";
import { pickDataFile } from "@/lib/dialogs";
import { ipc } from "@/lib/ipc";
import { classifyPath, fileName } from "@/lib/platform";
import { IS_WEB } from "@/lib/target";
import type { CsvOptions } from "@/types/dataset";
import { ERROR_TITLES, isAppError, type AppError } from "@/types/errors";
import { useData } from "./store";

const DELIMITERS = [
  { value: "auto", label: "Detect automatically" },
  { value: ",", label: "Comma ( , )" },
  { value: ";", label: "Semicolon ( ; )" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe ( | )" },
];
const ENCODINGS = [
  { value: "utf-8", label: "UTF-8" },
  { value: "utf-16", label: "UTF-16" },
  { value: "latin-1", label: "Latin-1 (ISO-8859-1)" },
];

export function ImportDialog() {
  const open = useUi((s) => s.importOpen);
  const initialPath = useUi((s) => s.importPath);
  const close = useUi((s) => s.closeImport);
  const navigate = useUi((s) => s.navigate);

  const [path, setPath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [delimiter, setDelimiter] = useState("auto");
  const [encoding, setEncoding] = useState<CsvOptions["encoding"]>("utf-8");
  const [header, setHeader] = useState(true);
  const [skipMalformed, setSkipMalformed] = useState(false);
  const [sheets, setSheets] = useState<string[] | null>(null);
  const [sheet, setSheet] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const kind = path ? classifyPath(path) : null;

  useEffect(() => {
    if (!open) return;
    setPath(initialPath);
    setError(null);
    setSheets(null);
    setSkipMalformed(false);
    setHeader(true);
    setDelimiter("auto");
    if (!initialPath) {
      void pickDataFile().then((p) => (p ? setPath(p) : !initialPath && close()));
    }
  }, [open, initialPath, close]);

  useEffect(() => {
    if (!path) return;
    setName(fileName(path).replace(/\.[^.]+$/, ""));
    setError(null);
    if (classifyPath(path) === "xlsx") {
      setSheets(null);
      ipc
        .listXlsxSheets(path)
        .then((s) => {
          setSheets(s);
          setSheet(s[0] ?? "");
          if (s.length > 1) setName((n) => `${n} – ${s[0]}`);
        })
        .catch((e) => setError(isAppError(e) ? e : { kind: "internal", message: String(e) }));
    }
  }, [path]);

  const runImport = async () => {
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const data = useData.getState();
      const meta =
        kind === "xlsx"
          ? await data.importXlsx(path, sheet, header, name || undefined)
          : await data.importCsv(
              path,
              { delimiter: delimiter === "auto" ? null : delimiter, header, encoding, skipMalformed },
              name || undefined,
            );
      toast({
        tone: "success",
        title: `Imported ${meta.name}`,
        description: `${meta.rowCount.toLocaleString()} rows · ${meta.columns.length} columns`,
      });
      close();
      navigate("data");
    } catch (e) {
      setError(isAppError(e) ? e : { kind: "internal", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import data</DialogTitle>
          <DialogDescription>
            {IS_WEB
              ? "Data is read into DuckDB running in this browser tab. Nothing is uploaded."
              : "Data is copied into a local DuckDB engine. Your file is not modified."}
          </DialogDescription>
        </DialogHeader>

        {!path && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Button onClick={() => void pickDataFile().then((p) => p && setPath(p))}>Choose a file…</Button>
            <span className="text-xs text-muted-foreground">CSV, TSV, XLSX, XLS or ODS</span>
          </div>
        )}

        {path && (
          <div className="grid gap-4">
            <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
              {kind === "xlsx" ? <FileSpreadsheet className="size-5 text-emerald-600" /> : <FileText className="size-5 text-primary" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{fileName(path)}</div>
                <div className="truncate text-xs text-muted-foreground" data-selectable>
                  {IS_WEB ? describePath(path) : path}
                </div>
              </div>
              <Button variant="ghost" size="xs" onClick={() => void pickDataFile().then((p) => p && setPath(p))}>
                Change
              </Button>
            </div>

            {kind === "unsupported" && (
              <div className="text-sm text-destructive">This file type is not supported. Choose a CSV or Excel file.</div>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="ds-name">Dataset name</Label>
              <Input id="ds-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            {kind === "csv" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Delimiter</Label>
                  <Select value={delimiter} onValueChange={setDelimiter}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DELIMITERS.map((d) => (
                        <SelectItem key={d.value} value={d.value}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>Encoding</Label>
                  <Select value={encoding ?? "utf-8"} onValueChange={(v) => setEncoding(v as CsvOptions["encoding"])}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ENCODINGS.map((d) => (
                        <SelectItem key={d.value} value={d.value}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {kind === "xlsx" && (
              <div className="grid gap-1.5">
                <Label>Sheet</Label>
                <Select
                  value={sheet}
                  onValueChange={(v) => {
                    setSheet(v);
                    setName(`${fileName(path).replace(/\.[^.]+$/, "")} – ${v}`);
                  }}
                  disabled={!sheets}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={sheets ? "Choose a sheet" : "Reading workbook…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {sheets?.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {(kind === "csv" || kind === "xlsx") && (
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={header} onCheckedChange={(v) => setHeader(v === true)} />
                  First row contains column names
                </label>
                {kind === "csv" && (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={skipMalformed} onCheckedChange={(v) => setSkipMalformed(v === true)} />
                    Skip malformed rows
                  </label>
                )}
              </div>
            )}

            {error && (
              <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" data-selectable>
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <div className="font-medium">{ERROR_TITLES[error.kind] ?? "Import failed"}</div>
                  <div className="mt-0.5 text-xs break-words text-muted-foreground">{error.message}</div>
                  {error.kind === "unsupportedEncoding" && (
                    <div className="mt-1 text-xs">Try a different encoding above.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void runImport()}
            disabled={busy || !path || kind === "unsupported" || kind === "project" || (kind === "xlsx" && !sheet)}
          >
            {busy && <Loader2 className="animate-spin" />}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
