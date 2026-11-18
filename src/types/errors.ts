/** Mirrors `AppError` serialisation in `src-tauri/src/error.rs`. */
export type AppErrorKind =
  | "fileNotFound"
  | "unsupportedFile"
  | "unsupportedEncoding"
  | "malformedRows"
  | "emptyFile"
  | "emptySheet"
  | "invalidQuery"
  | "invalidExpression"
  | "unknownDataset"
  | "unknownColumn"
  | "cancelled"
  | "database"
  | "io"
  | "internal";

export interface AppError {
  kind: AppErrorKind;
  message: string;
  position?: number;
}

export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    "message" in e &&
    typeof (e as AppError).message === "string"
  );
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const ERROR_TITLES: Partial<Record<AppErrorKind, string>> = {
  fileNotFound: "File not found",
  unsupportedFile: "Unsupported file",
  unsupportedEncoding: "Unsupported encoding",
  malformedRows: "Malformed rows",
  emptyFile: "Empty file",
  emptySheet: "Empty sheet",
  invalidQuery: "Invalid chart configuration",
  invalidExpression: "Invalid expression",
};
