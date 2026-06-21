export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** Discriminated union of file rendering modes. The loader picks the type
 *  via `classifyFile` + size check; `FileView` switches on `type`. Media
 *  variants (image/video/audio) carry a blob `url` whose lifetime is owned
 *  by the loader — it is revoked when a new file is loaded or the
 *  component unmounts. */
export type FileMedia =
  | { type: 'text'; content: string; size: number }
  | { type: 'markdown'; content: string; size: number }
  | { type: 'image'; mime: string; size: number; url: string }
  | { type: 'video'; mime: string; size: number; url: string }
  | { type: 'audio'; mime: string; size: number; url: string }
  | { type: 'binary'; size: number }
  | { type: 'tooLarge'; size: number };

export type ViewState =
  | { kind: 'loading' }
  | { kind: 'dir'; path: string; entries: DirEntry[] }
  | { kind: 'file'; path: string; media: FileMedia }
  | { kind: 'error'; path: string; message: string }
  | { kind: 'search'; query: string; results: DirEntry[]; paths: string[] }
  | { kind: 'allDocuments'; entries: AllDocsEntry[] };

/** Entry for the "All Documents" view — includes modification time. */
export interface AllDocsEntry {
  name: string;
  absPath: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
}
