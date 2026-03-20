// This file was written with Claude Code.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LeanEditsConfig } from '../config';
import { getController } from '../extension';
import { CONCRETE_NAME, EDITS_NAME } from '../tracking';

/**
 * Writes a .vscode/settings.json for the given workspace with the provided
 * LeanEdits config, and updates the live controller so VSCode picks it up
 * immediately without waiting for a config-change event.
 */
export async function setConfig(wsPath: string, config: LeanEditsConfig): Promise<void> {
    const vscodeDir = path.join(wsPath, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir);
    }
    const settings = {
        'lean-edits.participantName': config.participantName,
        'lean-edits.enabled': config.enabled,
    };
    fs.writeFileSync(path.join(vscodeDir, 'settings.json'), JSON.stringify(settings, null, 2));

    const ext = vscode.extensions.getExtension('KyleThompson.lean-edits');
    await ext?.activate();
    getController().updateConfig(config);
}

// --- Replay Logic ---

interface StoredChange {
    rangeOffset: number;
    rangeLength: number;
    text: string;
}

interface StoredEdit {
    file: string;
    time: number;
    changes: StoredChange[];
}

interface StoredCheckpointNew {
    type: 'new';
    contents: string;
    mtime: number;
}

interface StoredCheckpointSame {
    type: 'same';
    prevMtime: number;
    mtime: number;
}

type StoredCheckpoint = StoredCheckpointNew | StoredCheckpointSame;

function applyChange(base: string, change: StoredChange): string {
    return base.slice(0, change.rangeOffset) + change.text + base.slice(change.rangeOffset + change.rangeLength);
}

function applyEdit(base: string, edit: StoredEdit): string {
    let current = base;
    for (const change of edit.changes) {
        current = applyChange(current, change);
    }
    return current;
}

function resolveCheckpointContents(checkpoints: Map<number, StoredCheckpoint>, mtime: number): string {
    const cp = checkpoints.get(mtime);
    if (!cp) { throw new Error(`No checkpoint found for mtime ${mtime}`); }
    if (cp.type === 'new') { return cp.contents; }
    return resolveCheckpointContents(checkpoints, cp.prevMtime);
}

function loadCheckpoints(concreteDir: string): Map<number, StoredCheckpoint> {
    const checkpoints = new Map<number, StoredCheckpoint>();
    for (const filename of fs.readdirSync(concreteDir)) {
        const raw = JSON.parse(fs.readFileSync(path.join(concreteDir, filename), 'utf-8')) as StoredCheckpoint;
        checkpoints.set(parseInt(filename), raw);
    }
    return checkpoints;
}

function loadEdits(editsDir: string): StoredEdit[] {
    if (!fs.existsSync(editsDir)) { return []; }
    return fs.readdirSync(editsDir)
        .map(f => JSON.parse(fs.readFileSync(path.join(editsDir, f), 'utf-8')) as StoredEdit)
        .sort((a, b) => a.time - b.time);
}

/**
 * Recursively finds all file tracking directories within a commit dir.
 * A file tracking directory is one that contains an edits-history or
 * concrete-history subdirectory. Returns paths relative to commitDir.
 */
function findFileDirectories(dir: string, commitDir: string): string[] {
    const result: string[] = [];
    for (const entry of fs.readdirSync(dir)) {
        if (entry === 'metadata.json') { continue; }
        const entryPath = path.join(dir, entry);
        if (!fs.lstatSync(entryPath).isDirectory()) { continue; }
        const hasEdits = fs.existsSync(path.join(entryPath, EDITS_NAME));
        const hasConcrete = fs.existsSync(path.join(entryPath, CONCRETE_NAME));
        if (hasEdits || hasConcrete) {
            result.push(path.relative(commitDir, entryPath));
        } else {
            result.push(...findFileDirectories(entryPath, commitDir));
        }
    }
    return result;
}

/**
 * Replays the edit history of a file up to (and including) a given time.
 *
 * fileDir: the tracking directory for a specific file within the commit dir,
 *          e.g. .changes/<commit>/Main.lean/
 * targetTimeMs: replay up to this timestamp (inclusive)
 */
export function replayFileAtTime(fileDir: string, targetTimeMs: number): string {
    const concreteDir = path.join(fileDir, CONCRETE_NAME);
    const editsDir = path.join(fileDir, EDITS_NAME);

    const checkpoints = loadCheckpoints(concreteDir);
    const checkpointMtimes = Array.from(checkpoints.keys()).sort((a, b) => a - b);

    const edits = loadEdits(editsDir).filter(e => e.time <= targetTimeMs);

    if (edits.length === 0) {
        return resolveCheckpointContents(checkpoints, checkpointMtimes[0]);
    }

    const lastEditTime = edits[edits.length - 1].time;

    // The base checkpoint for a batch is the latest checkpoint whose mtime
    // predates the last edit in the batch (it represents the last saved state
    // before those in-memory edits were made).
    let baseMtime: number | undefined;
    for (const mtime of checkpointMtimes) {
        if (mtime < lastEditTime) {
            baseMtime = mtime;
        }
    }
    if (baseMtime === undefined) {
        throw new Error(`No checkpoint found before edit time ${lastEditTime}`);
    }

    const batchEdits = edits.filter(e => e.time > baseMtime!);
    let contents = resolveCheckpointContents(checkpoints, baseMtime);
    for (const edit of batchEdits) {
        contents = applyEdit(contents, edit);
    }
    return contents;
}

/**
 * Returns the replayed contents of every tracked file after a specific edit
 * to a given file has been applied.
 *
 * changesCommitDir: commit-specific directory, e.g. .changes/<commit>/
 * relFilePath:      relative path of the anchor file, e.g. "Main.lean"
 * editIdx:          0-based index into that file's edit history
 */
export function getWorkspaceStateAfterEdit(
    changesCommitDir: string,
    relFilePath: string,
    editIdx: number
): Map<string, string> {
    console.log(`Replaying workspace state after edit ${editIdx} to ${relFilePath} in commit dir ${changesCommitDir}`);
    const anchorEditsDir = path.join(changesCommitDir, relFilePath, EDITS_NAME);
    const anchorEdits = loadEdits(anchorEditsDir);
    if (editIdx >= anchorEdits.length) {
        throw new Error(`Edit index ${editIdx} out of range (${anchorEdits.length} edits for ${relFilePath})`);
    }
    const targetTimeMs = anchorEdits[editIdx].time + 1;

    const result = new Map<string, string>();
    for (const relPath of findFileDirectories(changesCommitDir, changesCommitDir)) {
        const fileDir = path.join(changesCommitDir, relPath);
        result.set(relPath, replayFileAtTime(fileDir, targetTimeMs));
    }
    return result;
}
