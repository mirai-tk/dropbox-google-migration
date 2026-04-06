/** @typedef {'full' | 'restricted' | 'none'} AccessLevel */

/**
 * Dropbox の list_folder エントリからアクセス段階を推定。
 * - none: sharing_info.no_access、または以前に list_folder が失敗した path
 * - restricted: traverse_only / read_only（閲覧のみ・一部のみ等）
 * - full: 上記以外
 *
 * API: FolderSharingInfo に no_access / traverse_only / read_only あり（JSON は snake_case）
 * @param {object} entry
 * @param {Set<string> | string[]} inaccessiblePaths path_lower の集合
 * @returns {AccessLevel}
 */
export function deriveDropboxAccess(entry, inaccessiblePaths) {
  const pl = entry.path_lower || '';
  const set = inaccessiblePaths instanceof Set ? inaccessiblePaths : new Set(inaccessiblePaths || []);
  if (pl && set.has(pl)) return 'none';

  const si = entry.sharing_info;
  if (si && typeof si === 'object') {
    if (si.no_access === true) return 'none';
    if (si.traverse_only === true) return 'restricted';
    if (si.read_only === true) return 'restricted';
  }
  return 'full';
}

/**
 * Google Drive files リソース（capabilities 付き）から推定。
 * @param {object} file
 * @returns {AccessLevel}
 */
export function deriveGDriveAccess(file) {
  if (file.isRoot || file.isSharedDrive) return 'full';
  const cap = file.capabilities;
  if (!cap || typeof cap !== 'object') return 'full';
  const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
  if (isFolder) {
    if (cap.canListChildren === false) return 'none';
    if (cap.canEdit === false) return 'restricted';
    return 'full';
  }
  if (cap.canDownload === false) return 'none';
  if (cap.canEdit === false) return 'restricted';
  return 'full';
}
