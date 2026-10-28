import { useContext, useEffect, useMemo, useState } from 'react';
import type { AppLanguage } from '../../types';
import { formatMessageList, uiText } from '../../i18n';
import { isImagePath, splitExplicitAttachmentMentions } from '../../shared/localPaths';
import { ConversationHostContext } from '../conversationHost';
import { MessageGalleryImageButton } from '../chatMessages/MessageImageGallery';
import { ImagePreviewDialog, type ImagePreviewSource } from '../chatMessages/ImagePreviewDialog';
import { appendGalleryImages, galleryImage } from '../chatMessages/imageGallery';

/** The queued prompt stays intact; only its explicit image attachments get a compact preview. */
export function QueuedPromptPreview({ text, language }: { text: string; language: AppLanguage }) {
  const host = useContext(ConversationHostContext);
  const t = uiText(language);
  const content = useMemo(() => {
    const parts = splitExplicitAttachmentMentions(text);
    const images = appendGalleryImages([], parts.paths.filter(isImagePath).map(path => galleryImage(path)));
    const label = images.length
      ? [...parts.paths.filter(path => !isImagePath(path)).map(path => `@${path}`), parts.text].filter(Boolean).join('\n')
        || formatMessageList(language, images.map(image => image.name))
      : text;
    return { images, label };
  }, [text, language]);
  const [preview, setPreview] = useState<ImagePreviewSource | null>(null);
  useEffect(() => setPreview(null), [text, host?.id]);
  return <div className="runtime-queue-content">
    {content.images.length > 0 && <div className="runtime-queue-images" role="group" aria-label={t('queue.images')}>
      <MessageGalleryImageButton image={{ path: content.images[0].path!, name: content.images[0].name }}
        language={language} onPreview={setPreview} compact />
      {content.images.length > 1 && <button className="runtime-queue-image-count" type="button"
        aria-label={t('queue.viewImages', { count: content.images.length })}
        onClick={() => setPreview(content.images[1])}>{t('queue.moreImages', { count: content.images.length - 1 })}</button>}
    </div>}
    <p className="runtime-queue-prompt" title={content.label}>{content.label}</p>
    {preview && <ImagePreviewDialog image={preview} images={content.images} initialScope="attachments"
      language={language} onClose={() => setPreview(null)} />}
  </div>;
}
