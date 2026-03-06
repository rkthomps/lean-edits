
export const EXTENSION_NAME = "lean-edits";

export const CONSENT_URL = "https://docs.google.com/forms/d/e/1FAIpQLSfkzrajoQ7KY7BnlP96nrHPpv0r2zAk80SNunL4p-l_saKKQg/viewform?usp=dialog";

export function extensionLog(message: string) {
    console.log(`[${EXTENSION_NAME}] ${message}`);
}