import * as vscode from "vscode";

export const EXTENSION_NAME = "lean-edits";

export const CONSENT_URL = "https://docs.google.com/forms/d/e/1FAIpQLSfkzrajoQ7KY7BnlP96nrHPpv0r2zAk80SNunL4p-l_saKKQg/viewform?usp=dialog";

export function extensionLog(message: string) {
    console.log(`[${EXTENSION_NAME}] ${message}`);
}

export async function waitUntilFocused(): Promise<void> {
    if (vscode.window.state.focused) return;
    await new Promise<void>(resolve => {
        const sub = vscode.window.onDidChangeWindowState(s => {
            if (s.focused) {
                sub.dispose();
                resolve();
            }
        });
    });
}

// A lock entry older than this is treated as abandoned (e.g. holder window
// crashed without releasing). Long enough to outlast a normal prompt, short
// enough that a real crash unblocks future activations quickly.
const STALE_AFTER_MS = 60_000;

type LockEntry = { ts: number };

function lockHeld(state: vscode.Memento, key: string): boolean {
    const entry = state.get<LockEntry>(key);
    return !!entry && Date.now() - entry.ts < STALE_AFTER_MS;
}

export async function tryAcquireLock(state: vscode.Memento, key: string): Promise<boolean> {
    if (lockHeld(state, key)) return false;
    await state.update(key, { ts: Date.now() } satisfies LockEntry);
    return true;
}

export async function releaseLock(state: vscode.Memento, key: string): Promise<void> {
    await state.update(key, undefined);
}

export async function waitForLockRelease(state: vscode.Memento, key: string): Promise<void> {
    while (lockHeld(state, key)) {
        await new Promise(r => setTimeout(r, 500));
    }
}