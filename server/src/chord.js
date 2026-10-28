// Minimal Chord REST client: just what follow-ups need (POST /v1/scheduled-tasks).
// https://api.chordhq.xyz/docs/scheduling/

export class Chord {
  constructor({ baseUrl, apiKey, workspaceId, teammateId, followupPlatform }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.workspaceId = workspaceId;
    this.teammateId = teammateId;
    this.platform = followupPlatform;
  }

  get configured() {
    return Boolean(this.apiKey && this.workspaceId && this.teammateId);
  }

  /**
   * Queues a REPORT task: at scheduledAt, Chord runs the teammate's full agent (with these same MCP tools)
   * on `prompt` and delivers the reply into the conversation.
   */
  async scheduleAgentRun({ scheduledAt, prompt, conversationId, idempotencyKey }) {
    const res = await fetch(`${this.baseUrl}/v1/scheduled-tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        task_type: 'REPORT',
        scheduled_at: scheduledAt,
        workspace_id: this.workspaceId,
        teammate_id: this.teammateId,
        payload: { prompt, platform: this.platform, conversation_id: conversationId },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // keep text for the error message
    }
    if (!res.ok) {
      const code = json?.error?.code || json?.code || res.status;
      const message = json?.error?.message || json?.message || text.slice(0, 300) || 'empty response';
      throw new Error(`Chord scheduled-tasks ${code}: ${message}`);
    }
    return { task_id: json?.id || json?.task_id || null, raw: json };
  }
}
