/**
 * バイト数を人間が読みやすい文字列に変換（B / KB / MB / GB / TB）
 * @param {number|string|null|undefined} bytes
 * @returns {string} 空文字は無効な入力時
 */
export function formatFileSize(bytes) {
  if (bytes == null || bytes === '') return '';
  const n = Number(bytes);
  if (Number.isNaN(n) || n < 0) return '';
  if (n === 0) return '0 B';

  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), units.length - 1);
  const v = n / k ** i;

  const s =
    i === 0
      ? String(Math.round(v))
      : v < 10
        ? v.toFixed(1).replace(/\.0$/, '')
        : String(Math.round(v));

  return `${s} ${units[i]}`;
}
