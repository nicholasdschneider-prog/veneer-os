import { api, type SessionFile } from './api';
import { artifactPathKey, type Artifact } from './artifacts';

/** Use server-listed canonical paths, including macOS /tmp aliases, never raw
 * Markdown paths as a request to the host filesystem. */
export function chatImageSources(conversationId: string, files: SessionFile[], artifacts: Artifact[]): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const artifact of artifacts) {
    if (artifact.type !== 'file') continue;
    sources.set(artifactPathKey(artifact.path), api.generatedFileDownloadUrl(artifact.id, { inline: true }));
  }
  for (const file of files) {
    const url = api.conversationFileInlineUrl(conversationId, file.path);
    sources.set(artifactPathKey(file.path), url);
    for (const alias of file.aliases ?? []) {
      if (!sources.has(artifactPathKey(alias))) sources.set(artifactPathKey(alias), url);
    }
  }
  return sources;
}
