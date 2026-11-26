/** OpenAI-style error body. Never include provider error text or stack traces: they can leak internals. */
export function sendError(res, req, status, code, message, headers = {}) {
  if (res.headersSent) return;
  res.set(headers).status(status).json({ error: { message, type: code, code, request_id: req.id } });
}
