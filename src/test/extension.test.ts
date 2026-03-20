// This test suite was written with Claude Code.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { setConfig, replayFileAtTime, getWorkspaceStateAfterEdit } from './helpers';
import { CHANGES_NAME, CONCRETE_NAME, EDITS_NAME } from '../tracking';

suite('Smoke Test', () => {
    const wsPath = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const changesDir = path.join(wsPath, CHANGES_NAME);
    const mainLeanPath = path.join(wsPath, 'Main.lean');

    let originalContent: string;

    setup(async () => {
        originalContent = fs.readFileSync(mainLeanPath, 'utf-8');
        await setConfig(wsPath, { participantName: 'test-user', enabled: true });
        if (fs.existsSync(changesDir)) {
            fs.rmSync(changesDir, { recursive: true });
        }
    });

    teardown(() => {
        fs.writeFileSync(mainLeanPath, originalContent);
        if (fs.existsSync(changesDir)) {
            fs.rmSync(changesDir, { recursive: true });
        }
    });

    test('edits are captured as edit records and concrete checkpoints', async () => {
        const uri = vscode.Uri.file(mainLeanPath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);

        // Capture baseline concrete checkpoint before making any edits
        await vscode.commands.executeCommand('lean-edits.syncCheckpoints');

        // Make some edits
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(0, 0), '-- smoke test\n');
        await vscode.workspace.applyEdit(edit);

        // Wait for the onDidChangeTextDocument handler to write the edit to disk
        await new Promise(resolve => setTimeout(resolve, 500));

        // .changes directory should exist
        assert.ok(fs.existsSync(changesDir), '.changes directory should exist');

        // There should be a commit subdirectory
        const commitDirs = fs.readdirSync(changesDir);
        assert.ok(commitDirs.length > 0, 'should have a commit subdirectory in .changes');

        const fileDir = path.join(changesDir, commitDirs[0], path.relative(wsPath, mainLeanPath));

        // There should be at least one edit record
        const editsDir = path.join(fileDir, EDITS_NAME);
        assert.ok(fs.existsSync(editsDir), 'edits-history directory should exist');
        assert.ok(fs.readdirSync(editsDir).length > 0, 'should have at least one edit record');

        // There should be at least one concrete checkpoint
        const concreteDir = path.join(fileDir, CONCRETE_NAME);
        assert.ok(fs.existsSync(concreteDir), 'concrete-history directory should exist');
        assert.ok(fs.readdirSync(concreteDir).length > 0, 'should have at least one concrete checkpoint');
    });
});


suite('Replay Test', () => {
    const wsPath = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const changesDir = path.join(wsPath, CHANGES_NAME);
    const f1Path = path.join(wsPath, 'Main.lean');
    const f2Path = path.join(wsPath, 'SimpleLeanProject.lean');
    const f1Rel = path.relative(wsPath, f1Path);
    const f2Rel = path.relative(wsPath, f2Path);

    let originalF1: string;
    let originalF2: string;

    setup(async () => {
        originalF1 = fs.readFileSync(f1Path, 'utf-8');
        originalF2 = fs.readFileSync(f2Path, 'utf-8');
        await setConfig(wsPath, { participantName: 'test-user', enabled: true });
        if (fs.existsSync(changesDir)) {
            fs.rmSync(changesDir, { recursive: true });
        }
    });

    teardown(() => {
        fs.writeFileSync(f1Path, originalF1);
        fs.writeFileSync(f2Path, originalF2);
        if (fs.existsSync(changesDir)) {
            fs.rmSync(changesDir, { recursive: true });
        }
    });

    test('replay matches actual edits, and all f1 edits are visible at last f2 edit', async () => {
        const uri1 = vscode.Uri.file(f1Path);
        const uri2 = vscode.Uri.file(f2Path);

        const doc1 = await vscode.workspace.openTextDocument(uri1);
        const doc2 = await vscode.workspace.openTextDocument(uri2);
        await vscode.window.showTextDocument(doc1);
        await vscode.window.showTextDocument(doc2);

        // Capture baseline concrete checkpoints before any edits
        await vscode.commands.executeCommand('lean-edits.syncCheckpoints');

        // --- Batch 1 ---
        const e1f1 = new vscode.WorkspaceEdit();
        e1f1.insert(uri1, new vscode.Position(0, 0), '-- f1 edit 1\n');
        await vscode.workspace.applyEdit(e1f1);
        await new Promise(resolve => setTimeout(resolve, 50));

        const e1f2 = new vscode.WorkspaceEdit();
        e1f2.insert(uri2, new vscode.Position(0, 0), '-- f2 edit 1\n');
        await vscode.workspace.applyEdit(e1f2);
        await new Promise(resolve => setTimeout(resolve, 50));

        // Save both files so their mtimes update, creating new base checkpoints
        // for the next batch of edits
        await doc1.save();
        await doc2.save();
        await new Promise(resolve => setTimeout(resolve, 50));

        // --- Batch 2 ---
        const e2f1 = new vscode.WorkspaceEdit();
        e2f1.insert(uri1, new vscode.Position(0, 0), '-- f1 edit 2\n');
        await vscode.workspace.applyEdit(e2f1);
        await new Promise(resolve => setTimeout(resolve, 50));

        const e2f2 = new vscode.WorkspaceEdit();
        e2f2.insert(uri2, new vscode.Position(0, 0), '-- f2 edit 2\n');
        await vscode.workspace.applyEdit(e2f2);

        // Wait for all onDidChangeTextDocument handlers to flush
        await new Promise(resolve => setTimeout(resolve, 500));

        // Find the commit directory
        assert.ok(fs.existsSync(changesDir), '.changes should exist');
        const commitDirs = fs.readdirSync(changesDir);
        assert.ok(commitDirs.length > 0);
        const commitDir = path.join(changesDir, commitDirs[0]);

        // The expected final contents (what VSCode has in memory)
        const expectedF1 = doc1.getText();
        const expectedF2 = doc2.getText();

        // Replay f1 and f2 to their final state and compare
        const f1FileDir = path.join(commitDir, f1Rel);
        const f2FileDir = path.join(commitDir, f2Rel);
        const f1EditsDir = path.join(f1FileDir, EDITS_NAME);
        const f2EditsDir = path.join(f2FileDir, EDITS_NAME);
        const f1EditCount = fs.readdirSync(f1EditsDir).length;
        const f2EditCount = fs.readdirSync(f2EditsDir).length;

        const replayedF1Final = replayFileAtTime(f1FileDir, Date.now());
        const replayedF2Final = replayFileAtTime(f2FileDir, Date.now());

        assert.strictEqual(replayedF1Final, expectedF1, 'replayed f1 should match actual f1 content');
        assert.strictEqual(replayedF2Final, expectedF2, 'replayed f2 should match actual f2 content');

        // At the time of the last edit to f2, all f1 edits should be visible
        assert.ok(f1EditCount >= 2, `f1 should have at least 2 edits, got ${f1EditCount}`);
        assert.ok(f2EditCount >= 2, `f2 should have at least 2 edits, got ${f2EditCount}`);

        const stateAtLastF2Edit = getWorkspaceStateAfterEdit(commitDir, f2Rel, f2EditCount - 1);
        const f1AtLastF2Edit = stateAtLastF2Edit.get(f1Rel)!;
        assert.ok(f1AtLastF2Edit !== undefined, 'f1 should be present in workspace state');
        assert.ok(f1AtLastF2Edit.includes('-- f1 edit 1'), 'f1 edit 1 should be visible at time of last f2 edit');
        assert.ok(f1AtLastF2Edit.includes('-- f1 edit 2'), 'f1 edit 2 should be visible at time of last f2 edit');
    });
});
