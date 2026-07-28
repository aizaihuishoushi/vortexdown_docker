/**
 * naming.js - Template engine for VortexDown
 * Variables: {name}, {season}, {s}, {episode}, {e}, {ep_title}, {ext}, {date}, {original}
 * Default template: "{name} S{season}E{episode}.{ext}"
 * Pure ESM, zero dependencies
 */

/**
 * Sanitize a filename by removing invalid characters
 */
export function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*$\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract episode number from various formats:
 * - 第01集 → 01
 * - EP01 → 01
 * - E01 → 01
 * - 第1集 → 01
 * - 01 → 01
 * - S01E01 → 01 (extract episode part)
 */
export function extractEpisode(text) {
  if (!text) return null;

  // 第01集 or 第1集
  let match = text.match(/第\s*(\d+)\s*集/);
  if (match) return parseInt(match[1], 10);

  // EP01 or E01 (case insensitive)
  match = text.match(/[Ee][Pp]?\s*(\d+)/);
  if (match) return parseInt(match[1], 10);

  // S01E01 - extract episode part
  match = text.match(/[Ss]\s*\d+\s*[Ee]\s*(\d+)/);
  if (match) return parseInt(match[1], 10);

  // Standalone number at end: 问心01.mp4 → 01
  match = text.match(/(\d+)\s*\.\w+$/);
  if (match) return parseInt(match[1], 10);

  // Standalone number: 01, 1
  match = text.match(/^\s*(\d{1,4})\s*$/);
  if (match) return parseInt(match[1], 10);

  return null;
}

/**
 * Extract extension from a URL or filename
 */
export function extractExtension(url) {
  if (!url) return 'mp4';

  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop().toLowerCase().split('?')[0];
    if (['mp4', 'mkv', 'ts', 'avi', 'flv', 'wmv', 'mov', 'mp3', 'm4a', 'flac', 'wav'].includes(ext)) {
      return ext;
    }
  } catch {
    // not a valid URL
  }

  // Try to extract from string as filename
  const parts = url.split('?')[0].split('.').pop().toLowerCase();
  if (['mp4', 'mkv', 'ts', 'avi', 'flv', 'wmv', 'mov', 'mp3', 'm4a', 'flac', 'wav'].includes(parts)) {
    return parts;
  }

  return 'mp4';
}

/**
 * Extract original filename from URL
 */
export function extractOriginalFilename(url) {
  if (!url) return '';
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop();
    return decodeURIComponent(filename) || '';
  } catch {
    const parts = url.split('/').pop().split('?')[0];
    return decodeURIComponent(parts) || '';
  }
}

/**
 * Pad a number to at least 2 digits
 */
function padNum(n) {
  if (n === null || n === undefined) return '';
  const num = parseInt(n, 10);
  return num < 10 ? `0${num}` : String(num);
}

/**
 * Get today's date string (YYYYMMDD)
 */
function getDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Apply template substitution
 * @param {string} template - template string with {var} placeholders
 * @param {object} vars - {name, season, episode, ep_title, ext, original, date}
 * @returns {string} substituted filename
 */
export function applyTemplate(template, vars) {
  const {
    name = '',
    season = 1,
    episode = null,
    ep_title = '',
    ext = 'mp4',
    original = '',
  } = vars;

  const date = getDateString();
  const s = padNum(season);
  const e = padNum(episode);

  return template
    .replace(/\{name\}/g, sanitizeFilename(name))
    .replace(/\{season\}/g, padNum(season))
    .replace(/\{s\}/g, s)
    .replace(/\{episode\}/g, padNum(episode))
    .replace(/\{e\}/g, e)
    .replace(/\{ep_title\}/g, sanitizeFilename(ep_title))
    .replace(/\{ext\}/g, ext)
    .replace(/\{date\}/g, date)
    .replace(/\{original\}/g, sanitizeFilename(original));
}

/**
 * Generate a filename for a task given its metadata
 * @param {object} task - task object with url, name, season, episode, epTitle, engine
 * @param {string} template - naming template
 * @returns {string} generated filename
 */
export function generateFilename(task, template = '{name} S{season}E{episode}.{ext}') {
  const vars = {
    name: task.name || '未命名',
    season: task.season || 1,
    episode: task.episode || 1,
    ep_title: task.epTitle || '',
    ext: (task.engine === 'm3u8' || task.engine === 'mpd' || task.engine === 'ism') ? 'mp4' : extractExtension(task.url),
    original: extractOriginalFilename(task.url),
  };
  const result = applyTemplate(template, vars);
  return sanitizeFilename(result);
}

/**
 * Generate the full save path for a task
 * @param {object} task - task object
 * @param {string} baseDir - base save directory
 * @param {string} template - naming template
 * @returns {string} full file path
 */
export function generateSavePath(task, baseDir, template = '{name} S{season}E{episode}.{ext}') {
  const filename = generateFilename(task, template);
  // Create subfolder: baseDir/name/
  const subfolder = sanitizeFilename(task.name || '未命名');
  return `${baseDir}/${subfolder}/${filename}`;
}
