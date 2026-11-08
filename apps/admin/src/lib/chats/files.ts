/**
 * Файлы чатов — закрытый бакет `chat-files`, папка — id чата
 * (`<чат>/<uuid>.<расширение>`; имя файла — в сообщении). Загрузка с
 * докачкой и показ — общие с задачами (lib/resumable-upload.ts). Картинки не
 * уменьшаем: в чатах передают и макеты, им нужен оригинал (бриф, боль № 10).
 */
import {
  downloadStorageFile,
  FileTooLarge,
  formatFileSize,
  MAX_FILE_BYTES,
  signedFileUrl,
  startResumableUpload,
  useSignedFileUrl,
  type ResumableUpload,
  type UploadState,
} from "@/lib/resumable-upload";
import type { ChatAttachment } from "./types";

export const CHAT_BUCKET = "chat-files";
export const CHAT_MAX_FILE_BYTES = MAX_FILE_BYTES;

export { formatFileSize };
export { FileTooLarge as ChatFileTooLarge };
export type ChatUploadState = UploadState;
export type ChatUpload = ResumableUpload;

/** Загрузка файла в чат — с докачкой; итог — вложение сообщения. */
export const startChatUpload = (chatId: string, file: File, onState: (s: UploadState) => void) =>
  startResumableUpload(CHAT_BUCKET, chatId, file, onState);

export const chatFileUrl = (path: string, download?: string) =>
  signedFileUrl(CHAT_BUCKET, path, download);

export const useChatFileUrl = (path: string | null | undefined) =>
  useSignedFileUrl(CHAT_BUCKET, path);

/** Скачать под исходным именем. */
export const downloadChatFile = (a: ChatAttachment) => downloadStorageFile(CHAT_BUCKET, a);
