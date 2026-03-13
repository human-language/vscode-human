import * as vscode from "vscode";
import { execFile } from "child_process";

/*
 * The hmn CLI writes diagnostics to stderr in this format:
 *
 *   error: message text
 *    --> file.hmn:12:4
 *     |
 *   12 | source line
 *     |    ^~~~
 *
 * We parse the "error:" line for the message and the " --> " line
 * for file, line, and column.
 */

interface ParsedError {
  file: string;
  line: number;
  col: number;
  message: string;
}

const ERROR_RE = /^error:\s*(.+)$/;
const LOCATION_RE = /^\s*-->\s*(.+):(\d+):(\d+)$/;

function parseErrors(stderr: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const lines = stderr.split("\n");

  let pendingMessage: string | null = null;

  for (const line of lines) {
    const errMatch = line.match(ERROR_RE);
    if (errMatch) {
      pendingMessage = errMatch[1];
      continue;
    }

    const locMatch = line.match(LOCATION_RE);
    if (locMatch && pendingMessage !== null) {
      errors.push({
        file: locMatch[1],
        line: parseInt(locMatch[2], 10),
        col: parseInt(locMatch[3], 10),
        message: pendingMessage,
      });
      pendingMessage = null;
    }
  }

  return errors;
}

export function validate(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
) {
  const config = vscode.workspace.getConfiguration("human");
  const hmnPath = config.get<string>("hmnPath", "hmn");
  const filePath = doc.uri.fsPath;

  execFile(hmnPath, ["validate", filePath], { timeout: 10000 }, (err, _stdout, stderr) => {
    const parsed = parseErrors(stderr || "");

    const diagnostics: vscode.Diagnostic[] = parsed.map((e) => {
      const line = Math.max(0, e.line - 1);
      const col = Math.max(0, e.col - 1);
      const range = new vscode.Range(line, col, line, col + 1);
      return new vscode.Diagnostic(range, e.message, vscode.DiagnosticSeverity.Error);
    });

    collection.set(doc.uri, diagnostics);
  });
}

export function clearDiagnostics(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
) {
  collection.delete(doc.uri);
}
