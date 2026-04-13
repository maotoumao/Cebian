import type { AgentTool } from '@mariozechner/pi-agent-core';
import { askUserTool } from './ask-user';
import { executeJsTool } from './execute-js';
import { readPageTool } from './read-page';
import { interactTool } from './interact';
import { tabTool } from './tab';
import { screenshotTool } from './screenshot';

/** All tools available to the Cebian agent. */
export const tools: AgentTool<any>[] = [
  askUserTool, executeJsTool, readPageTool, interactTool, tabTool, screenshotTool,
];
