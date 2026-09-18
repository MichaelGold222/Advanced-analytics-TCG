/**
 * Handing a generated file to the user.
 *
 * A normal page triggers a browser download directly. A page published as a
 * claude.ai Artifact cannot: the viewer mediates every save through the
 * `downloads` capability, and a plain download link silently does nothing
 * there. This resolves the capability when it exists and falls back to the
 * ordinary download everywhere else, so the same build works in both places.
 */

interface DownloadsNamespace {
  save(request: { filename: string; data: Blob | string | ArrayBuffer }): Promise<{ status: string }>
}

interface ClaudeRuntime {
  use(name: 'downloads'): Promise<DownloadsNamespace | null>
}

declare global {
  interface Window {
    claude?: ClaudeRuntime
  }
}

/** Resolves the host's save channel, or null when the page can download directly. */
async function hostDownloads(): Promise<DownloadsNamespace | null> {
  if (typeof window === 'undefined' || typeof window.claude?.use !== 'function') return null
  try {
    return await window.claude.use('downloads')
  } catch {
    return null
  }
}

export interface FileWriter {
  toBlob(): Promise<Blob>
  toFile(filename: string): Promise<void>
}

export type SaveOutcome = 'saved' | 'declined'

export async function saveFile(writer: FileWriter, filename: string): Promise<SaveOutcome> {
  const downloads = await hostDownloads()
  if (!downloads) {
    await writer.toFile(filename)
    return 'saved'
  }
  try {
    await downloads.save({ filename, data: await writer.toBlob() })
    return 'saved'
  } catch (err) {
    // The viewer saying no is an ordinary outcome, not a failure to report.
    const code = (err as { code?: string } | null)?.code
    if (code === 'declined' || code === 'rate_limited') return 'declined'
    throw new Error(
      code === 'too_large'
        ? 'That file is too large for this viewer to save. Try exporting fewer rows.'
        : `This viewer could not save the file${code ? ` (${code})` : ''}. Opening the app from a downloaded copy always works.`,
    )
  }
}
