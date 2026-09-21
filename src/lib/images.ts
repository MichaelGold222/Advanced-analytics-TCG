/** Slab pictures, stored by certificate. */
export type CertImages = Record<string, { image: string | null; thumbnail: string | null }>

/**
 * The picture stored for a certificate, preferring the smaller one.
 *
 * The thumbnail is what a table row wants; the full image is the fallback for
 * a cert that has one but no thumbnail. Either may be absent, and a card with
 * no certificate never has a picture at all, since the pictures are fetched by
 * certificate.
 */
export function thumbFor(images: CertImages, cert?: string): string | null {
  if (!cert) return null
  return images[cert]?.thumbnail ?? images[cert]?.image ?? null
}
