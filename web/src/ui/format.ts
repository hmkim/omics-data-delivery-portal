/** Human-readable sizes (binary units, 1 decimal) and durations for the download UI. */
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${UNITS[unit]}`;
}

export function formatDuration(seconds: number, lang: string): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ko = lang.startsWith('ko');
  const parts: string[] = [];
  if (h > 0) parts.push(ko ? `${h}시간` : `${h}h`);
  if (m > 0 || h > 0) parts.push(ko ? `${m}분` : `${m}m`);
  if (h === 0) parts.push(ko ? `${sec}초` : `${sec}s`);
  return parts.join(' ');
}

export function formatTime(iso: string, lang: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang.startsWith('ko') ? 'ko-KR' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}
