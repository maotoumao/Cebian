import type { AgentTool } from '@mariozechner/pi-agent-core';
import { askUserTool } from './ask-user';
import { executeJsTool } from './execute-js';

// Register interactive tools (side-effect imports)
import './ask-user-registry';

/** All tools available to the Cebian agent. */
export const tools: AgentTool<any>[] = [askUserTool, executeJsTool];
