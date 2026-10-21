// Read only this extension's private local file. Never expose it to web pages.
export function parseLocalEnv(text) {
  if (typeof text !== 'string' || text.length > 32768) throw new Error('Invalid local env file');
  let key = null;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?STARTLUX_API_KEY\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    if (key !== null) throw new Error('Duplicate local key');
    let value = match[1];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw new Error('Invalid local key');
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/, '');
    value = value.trim();
    if (!value || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error('Invalid local key');
    key = value;
  }
  return key;
}

export async function readLocalKey(runtime, fetchFile = fetch) {
  try {
    const response = await fetchFile(runtime.getURL('.env'), {
      cache: 'no-store', credentials: 'omit', redirect: 'error',
    });
    if (!response.ok) return null;
    return parseLocalEnv(await response.text());
  } catch { return null; } // A missing local file is normal in public builds.
}
