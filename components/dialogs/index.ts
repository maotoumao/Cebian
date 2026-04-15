import type { ComponentProps } from 'react';
import { ImagePreviewDialog } from './image-preview';
import { AIConfigDialog } from '@/components/ai-config/AIConfigDialog';

// Dialog registry — add new dialogs here.
// Types are auto-derived from component props.
export const dialogRenderers = {
  'image-preview': ImagePreviewDialog,
  'ai-config': AIConfigDialog,
} as const;

export type DialogName = keyof typeof dialogRenderers;

export type DialogRegistry = {
  [K in DialogName]: ComponentProps<(typeof dialogRenderers)[K]>;
};
