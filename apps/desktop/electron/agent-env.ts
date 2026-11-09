import { join } from 'node:path';

/** The env contract every PTY gets: agents locate their inbox (dispatched
 *  tasks) purely from environment variables. There is no outbox — results
 *  are observed via the terminal recording, never via the mailbox. */
export function buildAgentEnv(
  sessionId: string,
  agentId: string,
  role: 'agent' | 'judge',
  sessionDir: string,
): Record<string, string> {
  const box = join(sessionDir, 'agents', agentId);
  return {
    FRAKTOLE_SESSION_ID: sessionId,
    FRAKTOLE_SESSION_DIR: sessionDir,
    FRAKTOLE_AGENT_ID: agentId,
    FRAKTOLE_ROLE: role,
    FRAKTOLE_INBOX: join(box, 'inbox'),
  };
}
