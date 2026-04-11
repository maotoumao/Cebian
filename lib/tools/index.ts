import type { AgentTool } from '@mariozechner/pi-agent-core';
import { askUserTool } from './ask-user';

/** All tools available to the Cebian agent. */
export const tools: AgentTool<any>[] = [askUserTool];
