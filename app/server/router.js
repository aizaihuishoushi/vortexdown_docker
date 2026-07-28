/**
 * router.js - Smart link type detector for VortexDown
 * Detects HTTP vs M3U8 vs MPD vs ISM link types
 * Also handles "name URL" paired format (quantum resource site style)
 * Pure ESM, zero dependencies
 */

/**
 * Known video file extensions for HTTP direct download
 */
const HTTP_EXTENSIONS = new Set([
  'mp4', 'mkv', 'ts', 'avi', 'flv', 'wmv', 'mov',
  'mp3', 'm4a', 'flac', 'wav', 'webm', 'rmvb', 'rm',
  'iso', 'mpg', 'mpeg', 'm4v', '3gp',
]);

/**
 * Known video extensions for URL extension detection
 */
const VIDEO_EXT_PATTERN = /\.(mp4|mkv|ts|avi|flv|wmv|mov|m3u8|mpd|ism|webm|rmvb|mpg|mpeg|m4v|3gp)\b/i;

/**
 * Detect link type from a URL
 * @param {string} url - the URL to detect
 * @returns {string} 'http' | 'm3u8' | 'mpd' | 'ism'
 */
export function detectLinkType(url) {
  if (!url) return 'http';

  const lowerUrl = url.toLowerCase().trim();

  // Check for M3U8
  if (lowerUrl.endsWith('.m3u8') || lowerUrl.includes('.m3u8?') || lowerUrl.includes('/m3u8')) {
    return 'm3u8';
  }

  // Check for MPD (DASH)
  if (lowerUrl.endsWith('.mpd') || lowerUrl.includes('.mpd?')) {
    return 'mpd';
  }

  // Check for ISM (Smooth Streaming)
  if (lowerUrl.endsWith('.ism') || lowerUrl.endsWith('.ism/manifest') ||
      lowerUrl.includes('/manifest(') || lowerUrl.includes('qualitylevels')) {
    return 'ism';
  }

  // Check for known video extensions -> HTTP direct download
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop().toLowerCase().split('?')[0];
    if (HTTP_EXTENSIONS.has(ext)) {
      return 'http';
    }
  } catch {
    // Invalid URL, treat as HTTP
  }

  // Default to HTTP
  return 'http';
}

/**
 * Extract episode number from various name formats
 * @param {string} text - text to extract from
 * @returns {number|null} episode number or null
 */
export function extractEpisodeFromText(text) {
  if (!text) return null;

  // 第01集 or 第1集
  let match = text.match(/第\s*(\d+)\s*集/);
  if (match) return parseInt(match[1], 10);

  // EP01 or E01
  match = text.match(/[Ee][Pp]?\s*(\d+)/);
  if (match) return parseInt(match[1], 10);

  // S01E01
  match = text.match(/[Ss]\s*\d+\s*[Ee]\s*(\d+)/);
  if (match) return parseInt(match[1], 10);

  // 中文名+数字: 红楼梦111, 问心12（纯中文名后面跟数字作为集数）
  // 使用非字母断言避免匹配到 mp4 的 4、mkv 的 v 等扩展名中的数字
  match = text.match(/(?:^|[^a-zA-Z.])(\d+)$/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (num >= 2) return num;
  }

  return null;
}

/**
 * Extract episode number from URL filename
 * @param {string} url - the URL
 * @returns {number|null} episode number or null
 */
export function extractEpisodeFromUrl(url) {
  if (!url) return null;
  try {
    const pathname = new URL(url).pathname;
    // 解码 URL 编码的字符（%20 → 空格, %E9%87%91 → 金 等）
    const filename = decodeURIComponent(pathname.split('/').pop());

    // EP36, Ep01, ep01 等（文件名中的集数标记）
    let match = filename.match(/[Ee][Pp](\d+)/);
    if (match) return parseInt(match[1], 10);

    // 问心01.mp4 → 01 (文件名末尾数字+扩展名)
    match = filename.match(/(\d{1,4})\s*\.\w+$/);
    if (match) return parseInt(match[1], 10);

    // 纯数字文件名: 01.mp4
    match = filename.match(/^(\d{1,4})\.\w+$/);
    if (match) return parseInt(match[1], 10);
  } catch {
    // fallback: try regex on raw string (URL may be malformed)
    const parts = url.split('/').pop().split('?')[0];
    let match = parts.match(/[Ee][Pp](\d+)/);
    if (match) return parseInt(match[1], 10);
    match = parts.match(/(\d{1,4})\s*\.\w+$/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/**
 * 延伸 URL：如果 URL 以空格结尾且后面跟着文件名，自动拼接
 * 例如 "https://.../金特务：本色回归 01.mp4" → 完整 URL
 * @param {string} url - 当前匹配到的 URL
 * @param {string} fullLine - 原始整行文本
 * @returns {string} 延伸后的 URL
 */
function extendUrlWithTrailingFilename(url, fullLine) {
  // 如果 URL 已经以视频扩展名结束，无需延伸
  if (VIDEO_EXT_PATTERN.test(url)) return url;

  const idx = fullLine.indexOf(url);
  if (idx < 0) return url;

  const remainder = fullLine.substring(idx + url.length);
  // 匹配: 空格/中文冒号/分号 + 文件名.mp4 等
  // 例如 " 01.mp4"、" 05.mp4"、"：本色回归01.mp4"
  // 关键：保留分隔符（空格/冒号），否则 URL 变成 "回归01.mp4" 丢失空格
  const extMatch = remainder.match(/^([\s：:;]+)([^\s：:;]*\.(?:mp4|mkv|ts|avi|flv|wmv|mov|m3u8|mpd|ism|webm|rmvb|mpg|mpeg|m4v|3gp))/i);
  if (extMatch) {
    // extMatch[1] = 分隔符（空格/冒号等），extMatch[2] = 文件名
    return url + extMatch[1] + extMatch[2];
  }
  return url;
}

/**
 * Parse a line that might be in "name URL" format
 * 支持的格式：
 *   第01集$https://xxx/yyy 01.mp4        （$ 分隔符）
 *   第01集$`https://xxx/yyy`：01.mp4     （反引号包裹）
 *   第01集 https://xxx/yyy 01.mp4        （空格分隔）
 *   https://xxx/yyy 01.mp4               （纯 URL，文件名含空格）
 *   https://xxx/index.m3u8               （M3U8 纯 URL）
 * @param {string} line - a single line from multiline input
 * @returns {object} {name, url, episode, engine}
 */
export function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // ============================================================
  // 策略1: $ 分隔符格式（量子资源网"复制名称$链接"）
  //   第01集$https://xxx/yyy 01.mp4
  //   第01集$https://xxx/index.m3u8
  // ============================================================
  const dollarIdx = trimmed.lastIndexOf('$');
  if (dollarIdx > 0) {
    const afterDollar = trimmed.substring(dollarIdx + 1).trim();
    if (afterDollar.startsWith('http')) {
      // 清理可能的反引号
      let url = afterDollar.replace(/`/g, '').trim();
      // 延伸空格后的文件名
      url = extendUrlWithTrailingFilename(url, afterDollar);
      const namePart = trimmed.substring(0, dollarIdx).trim();
      const episode = extractEpisodeFromText(namePart) || extractEpisodeFromUrl(url);
      const engine = detectLinkType(url);
      return { name: namePart, url, episode, engine, isPaired: true };
    }
  }

  // ============================================================
  // 策略2: 反引号包裹格式
  //   第01集$`https://xxx/yyy`：本色回归 01.mp4
  // ============================================================
  const backtickMatch = trimmed.match(/`([^`]*https?:\/\/[^`]*)`/);
  if (backtickMatch) {
    let url = backtickMatch[1].trim();
    url = url.replace(/[：:；"'<>\s]+$/, '').trim();

    const beforeUrl = trimmed.substring(0, backtickMatch.index).trim();
    const afterUrl = trimmed.substring(backtickMatch.index + backtickMatch[0].length).trim();

    // 反引号后如果有文件名，拼接（保留分隔符）
    const extMatch = afterUrl.match(/^([：:；\s]*)([^\s]*\.(?:mp4|mkv|ts|avi|flv|wmv|mov|m3u8|mpd|ism))\b/i);
    if (extMatch && !VIDEO_EXT_PATTERN.test(url)) {
      url = url.replace(/\s+$/, '') + extMatch[1] + extMatch[2];
    }

    let namePart = beforeUrl.replace(/[\$`]+$/, '').trim();
    const afterClean = afterUrl.replace(/^[：:；\s]+/, '').trim();
    if (afterClean && afterClean.length > 3 && !afterClean.match(/^\d+\.(mp4|mkv|ts)$/i)) {
      namePart = (namePart + ' ' + afterClean).trim();
    }

    const episode = extractEpisodeFromText(namePart) || extractEpisodeFromUrl(url);
    const engine = detectLinkType(url);
    return { name: namePart, url, episode, engine, isPaired: true };
  }

  // ============================================================
  // 策略3: 常规 "name URL" 格式（空格分隔）
  //   第01集 https://xxx/yyy.mp4
  // ============================================================
  const urlPattern = /https?:\/\/\S+/;
  const urlMatch = trimmed.match(urlPattern);

  if (urlMatch) {
    let url = extendUrlWithTrailingFilename(urlMatch[0], trimmed);
    const namePart = trimmed.replace(urlMatch[0], '').trim();

    if (namePart) {
      const episode = extractEpisodeFromText(namePart) || extractEpisodeFromUrl(url);
      const engine = detectLinkType(url);
      return { name: namePart, url, episode, engine, isPaired: true };
    }

    // namePart 为空但 URL 被延伸了，走纯 URL 逻辑
    if (url !== urlMatch[0]) {
      const episode = extractEpisodeFromUrl(url);
      const engine = detectLinkType(url);
      return { name: '', url, episode, engine, isPaired: false };
    }
  }

  // ============================================================
  // 策略4: 纯 URL（含空格的 HTTP 直链、纯 M3U8 等）
  // ============================================================
  let url = extendUrlWithTrailingFilename(trimmed, trimmed);
  const episode = extractEpisodeFromUrl(url);
  const engine = detectLinkType(url);
  return {
    name: '',
    url,
    episode,
    engine,
    isPaired: false,
  };
}

/**
 * Parse multiline text into a list of parsed entries
 * @param {string} text - multiline text input
 * @returns {Array<object>} list of parsed entries
 */
export function parseMultilineLinks(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const results = [];
  let autoEpisode = 0;

  for (const line of lines) {
    // 跳过不含 URL 的标题行（如"http下载地址："、"复制链接："、"复制名称$链接："等）
    if (!/https?:\/\//.test(line)) continue;

    const parsed = parseLine(line);
    if (!parsed) continue;

    autoEpisode++;

    // If episode wasn't found from name or URL, use auto-increment
    if (parsed.episode === null) {
      parsed.episode = autoEpisode;
    }

    results.push(parsed);
  }

  return results;
}