// Heuristic signals, not a guarantee. They drive two decisions:
//  - sensitive text is never written to the response cache;
//  - injection-looking text is flagged in usage logs (and optionally blocked with BLOCK_INJECTION=true).
// Prompt injection cannot be fully solved at a gateway: treat this as one layer of defence in depth.
const SENSITIVE = [
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, // email
  /\b(?:\d[ -]?){13,19}\b/, // card-like number
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN
  /\b\d{4}\s\d{4}\s\d{4}\b/, // Aadhaar-like
  /\b[A-Z]{5}\d{4}[A-Z]\b/, // PAN-like
  /\b(?:\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/, // phone
  /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{10,})/, // API keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]/i,
];

const INJECTION = [
  /ignore (?:all |any |the )?(?:previous|prior|above) (?:instructions|prompts)/i,
  /disregard (?:the )?(?:system|previous|above)/i,
  /reveal (?:your|the) (?:system )?prompt/i,
  /you are now (?:dan|in developer mode)/i,
  /\bjailbreak\b/i,
];

export const hasSensitive = (text) => SENSITIVE.some((r) => r.test(text));
export const injectionSignals = (text) => INJECTION.filter((r) => r.test(text)).map((r) => r.source.slice(0, 24));
