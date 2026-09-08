import type { ComponentType } from 'react';
import { fileUrl } from '../../shared/localPaths';
import type { AppLanguage } from '../../types';
import { FilePreviewFallback } from './FilePreviewFallback';
import { MediaInspectorPreview } from './MediaInspectorPreview';
import { MarkdownInspectorPreview, SourceInspectorPreview } from './TextInspectorPreview';

export type InspectorFilePreviewProps = {
  path: string;
  source: string;
  language: AppLanguage;
  onLoadingChange: (loading: boolean) => void;
};

function mediaRenderer(kind: 'image' | 'video' | 'audio'): ComponentType<InspectorFilePreviewProps> {
  return props => <MediaInspectorPreview {...props} kind={kind} source={fileUrl(props.path)} />;
}

/** Add a renderer here, then register its supported formats in filePreviewRegistry.ts. */
export const inspectorFilePreviewRenderers = {
  markdown: MarkdownInspectorPreview,
  text: SourceInspectorPreview,
  image: mediaRenderer('image'),
  video: mediaRenderer('video'),
  audio: mediaRenderer('audio'),
  fallback: FilePreviewFallback,
} satisfies Record<string, ComponentType<InspectorFilePreviewProps>>;

export type InspectorFilePreviewRenderer = Exclude<keyof typeof inspectorFilePreviewRenderers, 'fallback'>;
