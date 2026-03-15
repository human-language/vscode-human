import * as vscode from "vscode";
import { execFile } from "child_process";

/*
 * The hmn CLI writes diagnostics to stderr in this format:
 *
 *   error[E101]: message text
 *    --> file.hmn:12:4
 *     |
 *   12 | source line
 *     |    ^~~~
 *     |
 *   help: actionable hint text
 *
 * Same-file secondary labels appear inline:
 *    1 | AGENT bot
 *      | ----- first declared here
 *     ...
 *    5 | AGENT other
 *      | ^~~~~ duplicate
 *
 * Cross-file secondary labels get their own --> header:
 *    --> other.hmn:1:1
 *     |
 *    1 | AGENT bot
 *      | ----- first declared here
 */

interface SecondaryInfo {
  file: string;
  line: number;
  col: number;
  spanLen: number;
  message: string;
}

interface ParsedError {
  code: string;
  file: string;
  line: number;
  col: number;
  spanLen: number;
  message: string;
  hint: string | null;
  secondaries: SecondaryInfo[];
}

const ERROR_RE = /^error\[(\w+)]:\s*(.+)$/;
const LOCATION_RE = /^\s*-->\s*(.+):(\d+):(\d+)$/;
const FILE_LEVEL_RE = /^\s*-->\s*(\S+)$/;
const CARET_RE = /^\s*\|\s*(\^[~]*)\s*(.*)$/;
const SECONDARY_RE = /^\s*\|\s*(-+)\s+(.+)$/;
const HELP_RE = /^help:\s*(.+)$/;
const SOURCE_RE = /^\s*(\d+)\s*\|\s/;

function parseErrors(stderr: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const lines = stderr.split("\n");

  let current: ParsedErrorBuilder | null = null;
  let lastSourceLine = 0;
  let lastSourceFile = "";

  for (const line of lines) {
    const errMatch = line.match(ERROR_RE);
    if (errMatch) {
      if (current && current.file) {
        errors.push(finalize(current));
      }
      current = {
        code: errMatch[1],
        message: errMatch[2],
        file: "",
        line: 0,
        col: 0,
        spanLen: 1,
        hint: null,
        secondaries: [],
      };
      lastSourceLine = 0;
      lastSourceFile = "";
      continue;
    }

    if (!current) continue;

    const locMatch = line.match(LOCATION_RE);
    if (locMatch) {
      const file = locMatch[1];
      const ln = parseInt(locMatch[2], 10);
      const cl = parseInt(locMatch[3], 10);

      if (!current.file) {
        current.file = file;
        current.line = ln;
        current.col = cl;
        lastSourceFile = file;
      } else {
        current.secondaries.push({
          file,
          line: ln,
          col: cl,
          spanLen: 1,
          message: "",
        });
        lastSourceFile = file;
      }
      continue;
    }

    const fileLevelMatch = line.match(FILE_LEVEL_RE);
    if (fileLevelMatch && !current.file) {
      current.file = fileLevelMatch[1];
      lastSourceFile = current.file;
      continue;
    }

    // Track source line numbers for same-file secondary detection
    const sourceMatch = line.match(SOURCE_RE);
    if (sourceMatch) {
      lastSourceLine = parseInt(sourceMatch[1], 10);
    }

    const caretMatch = line.match(CARET_RE);
    if (caretMatch) {
      current.spanLen = caretMatch[1].length;
      continue;
    }

    const secMatch = line.match(SECONDARY_RE);
    if (secMatch) {
      const dashLen = secMatch[1].length;
      const text = secMatch[2];

      // Check if there's already a secondary from a --> line we can attach to
      const lastSec =
        current.secondaries.length > 0
          ? current.secondaries[current.secondaries.length - 1]
          : null;

      if (lastSec && !lastSec.message) {
        lastSec.message = text;
        lastSec.spanLen = dashLen;
      } else {
        // Same-file secondary (no preceding --> line)
        current.secondaries.push({
          file: lastSourceFile || current.file,
          line: lastSourceLine,
          col: 1,
          spanLen: dashLen,
          message: text,
        });
      }
      continue;
    }

    const helpMatch = line.match(HELP_RE);
    if (helpMatch) {
      current.hint = helpMatch[1];
      continue;
    }
  }

  if (current && current.file) {
    errors.push(finalize(current));
  }

  return errors;
}

interface ParsedErrorBuilder {
  code: string;
  file: string;
  line: number;
  col: number;
  spanLen: number;
  message: string;
  hint: string | null;
  secondaries: SecondaryInfo[];
}

function finalize(b: ParsedErrorBuilder): ParsedError {
  return {
    code: b.code,
    file: b.file,
    line: b.line,
    col: b.col,
    spanLen: b.spanLen,
    message: b.message,
    hint: b.hint,
    secondaries: b.secondaries,
  };
}

export function validate(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
) {
  const config = vscode.workspace.getConfiguration("human");
  const hmnPath = config.get<string>("hmnPath", "hmn");
  const filePath = doc.uri.fsPath;

  execFile(
    hmnPath,
    ["validate", filePath],
    { timeout: 10000 },
    (err, _stdout, stderr) => {
      const parsed = parseErrors(stderr || "");

      const diagnostics: vscode.Diagnostic[] = parsed.map((e) => {
        const line = Math.max(0, e.line - 1);
        const col = Math.max(0, e.col - 1);
        const endCol = col + Math.max(1, e.spanLen);
        const range = new vscode.Range(line, col, line, endCol);

        const diag = new vscode.Diagnostic(
          range,
          e.message,
          vscode.DiagnosticSeverity.Error
        );

        diag.code = e.code;
        diag.source = "hmn";

        if (e.secondaries.length > 0) {
          diag.relatedInformation = e.secondaries
            .filter((s) => s.message)
            .map((s) => {
              const sLine = Math.max(0, s.line - 1);
              const sCol = Math.max(0, s.col - 1);
              const sEndCol = sCol + Math.max(1, s.spanLen);
              const sRange = new vscode.Range(sLine, sCol, sLine, sEndCol);
              const uri = vscode.Uri.file(s.file);
              return new vscode.DiagnosticRelatedInformation(
                new vscode.Location(uri, sRange),
                s.message
              );
            });
        }

        return diag;
      });

      collection.set(doc.uri, diagnostics);
    }
  );
}

export function clearDiagnostics(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
) {
  collection.delete(doc.uri);
}
