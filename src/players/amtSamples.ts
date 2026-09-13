/** AMT samples ship beside the app, including the offline Pi edition. */
export function amtSampleUrl(name: string): string {
  return `${import.meta.env.BASE_URL}samples/amt/${name}-ogg.js`;
}

/** Bound both headers and body download: a stalled asset must not leave a voice
 * permanently waiting for readiness. Soundfont propagates rejection to Players. */
export const amtSampleStorage = {
  async fetch(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {signal: controller.signal});
      if (!response.ok) throw new Error(`AMT sample ${response.status}: ${url}`);
      const body = await response.arrayBuffer();
      return new Response(body, {status: response.status, headers: response.headers});
    } finally { clearTimeout(timeout); }
  },
};
