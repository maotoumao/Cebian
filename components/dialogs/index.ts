import type { ComponentProps } from 'react';
import { ImagePreviewDialog } from './image-preview';
import { CustomizationsDialog } from '@/components/customizations/CustomizationsDialog';

// Dialog registry — add new dialogs here.
// Types are auto-derived from component props.
export const dialogRenderers = {
  'image-preview': ImagePreviewDialog,
  'customizations': CustomizationsDialog,
} as const;

export type DialogName = keyof typeof dialogRenderers;

export type DialogRegistry = {
  [K in DialogName]: ComponentProps<(typeof dialogRenderers)[K]>;
};
