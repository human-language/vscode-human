import * as vscode from "vscode";
import { validate, clearDiagnostics } from "./diagnostics";

let diagnostics: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection("hmn");
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== "hmn") return;
      const config = vscode.workspace.getConfiguration("human");
      if (config.get<boolean>("validateOnSave", true)) {
        validate(doc, diagnostics);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      clearDiagnostics(doc, diagnostics);
    })
  );

  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === "hmn") {
      validate(doc, diagnostics);
    }
  }
}

export function deactivate() {
  diagnostics?.dispose();
}
