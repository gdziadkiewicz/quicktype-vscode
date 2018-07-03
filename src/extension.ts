"use strict";

import * as vscode from "vscode";
import { Range } from "vscode";
import { read as readClipboard } from "clipboardy";
import {
    quicktype,
    languageNamed,
    SerializedRenderResult,
    defaultTargetLanguages,
    JSONSchemaInput,
    InputData,
    TargetLanguage,
    jsonInputForTargetLanguage
} from "quicktype-core";
import { schemaForTypeScriptSources } from "quicktype-typescript-input";

import * as analytics from "./analytics";

enum Command {
    PasteJSONAsTypes = "quicktype.pasteJSONAsTypes",
    PasteJSONAsTypesAndSerialization = "quicktype.pasteJSONAsTypesAndSerialization",
    PasteSchemaAsTypes = "quicktype.pasteJSONSchemaAsTypes",
    PasteSchemaAsTypesAndSerialization = "quicktype.pasteJSONSchemaAsTypesAndSerialization",
    PasteTypeScriptAsTypesAndSerialization = "quicktype.pasteTypeScriptAsTypesAndSerialization"
}

function jsonIsValid(json: string) {
    try {
        JSON.parse(json);
    } catch (e) {
        return false;
    }
    return true;
}

async function promptTopLevelName(): Promise<{ cancelled: boolean; name: string }> {
    let topLevelName = await vscode.window.showInputBox({
        prompt: "Top-level type name?"
    });

    return {
        cancelled: topLevelName === undefined,
        name: topLevelName || "TopLevel"
    };
}

async function getTargetLanguage(editor: vscode.TextEditor): Promise<{ cancelled: boolean; lang: TargetLanguage }> {
    const documentLanguage = editor.document.languageId;
    const currentLanguage = languageNamed(documentLanguage);
    if (currentLanguage !== undefined) {
        return {
            cancelled: false,
            lang: currentLanguage
        };
    }

    const languageChoices = defaultTargetLanguages.map(l => l.displayName).sort();
    let chosenName = await vscode.window.showQuickPick(languageChoices);
    if (chosenName === undefined) {
        chosenName = "swift";
    }
    return {
        cancelled: chosenName === undefined,
        lang: languageNamed(chosenName)
    };
}

async function pasteAsTypes(editor: vscode.TextEditor, kind: "json" | "schema" | "typescript", justTypes: boolean) {
    let indentation: string;
    if (editor.options.insertSpaces) {
        const tabSize = editor.options.tabSize as number;
        indentation = " ".repeat(tabSize);
    } else {
        indentation = "\t";
    }

    const language = await getTargetLanguage(editor);
    if (language.cancelled) {
        return;
    }

    let content: string;
    try {
        content = await readClipboard();
    } catch (e) {
        vscode.window.showErrorMessage("Could not get clipboard contents");
    }

    if (kind !== "typescript" && !jsonIsValid(content)) {
        vscode.window.showErrorMessage("Clipboard does not contain valid JSON.");
        return;
    }

    const rendererOptions = {};
    if (justTypes) {
        rendererOptions["just-types"] = "true";
        rendererOptions["features"] = "just-types";
    }

    let topLevelName: string;
    if (kind === "typescript") {
        topLevelName = "input";
    } else {
        const tln = await promptTopLevelName();
        if (tln.cancelled) {
            return;
        }
        topLevelName = tln.name;
    }

    const inputData = new InputData();
    switch (kind) {
        case "json":
            await inputData.addSource("json", { name: topLevelName, samples: [content] }, () =>
                jsonInputForTargetLanguage(language.lang)
            );
            break;
        case "schema":
            await inputData.addSource(
                "schema",
                { name: topLevelName, schema: content },
                () => new JSONSchemaInput(undefined)
            );
            break;
        case "typescript":
            await inputData.addSource(
                "schema",
                schemaForTypeScriptSources({
                    [`${topLevelName}.ts`]: content
                }),
                () => new JSONSchemaInput(undefined)
            );
            break;
        default:
            vscode.window.showErrorMessage(`Unrecognized input format: ${kind}`);
            return;
    }

    analytics.sendEvent(`paste ${kind}`, language.lang.name);

    let result: SerializedRenderResult;
    try {
        const configuration = vscode.workspace.getConfiguration('quicktype');
        result = await quicktype({
            lang: language.lang,
            inputData,
            leadingComments: ["Generated by https://quicktype.io"],
            rendererOptions,
            indentation,
            inferMaps: configuration.inferMaps,
            inferEnums: configuration.inferEnums,
            inferDates: configuration.inferDates,
            inferIntegerStrings: configuration.inferIntegerStrings
        });
    } catch (e) {
        // TODO Invalid JSON produces an uncatchable exception from quicktype
        // Fix this so we can catch and show an error message.
        vscode.window.showErrorMessage(e);
        return;
    }

    const text = result.lines.join("\n");
    const selection = editor.selection;
    editor.edit(builder => {
        if (selection.isEmpty) {
            builder.insert(selection.start, text);
        } else {
            builder.replace(new Range(selection.start, selection.end), text);
        }
    });
}

export function activate(context: vscode.ExtensionContext) {
    analytics.initialize(context);

    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand(Command.PasteJSONAsTypes, editor =>
            pasteAsTypes(editor, "json", true)
        ),
        vscode.commands.registerTextEditorCommand(Command.PasteJSONAsTypesAndSerialization, editor =>
            pasteAsTypes(editor, "json", false)
        ),
        vscode.commands.registerTextEditorCommand(Command.PasteSchemaAsTypes, editor =>
            pasteAsTypes(editor, "schema", true)
        ),
        vscode.commands.registerTextEditorCommand(Command.PasteSchemaAsTypesAndSerialization, editor =>
            pasteAsTypes(editor, "schema", false)
        ),
        vscode.commands.registerTextEditorCommand(Command.PasteTypeScriptAsTypesAndSerialization, editor =>
            pasteAsTypes(editor, "typescript", false)
        )
    );
}

export function deactivate(): void {
    return;
}
