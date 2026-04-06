/**
 * フォルダ名などの入力で、IME 変換確定の Enter を「送信」と誤認しないための判定。
 * @param {React.KeyboardEvent} e
 * @returns {boolean} true のときは Enter で確定処理をしない（変換中の Enter）
 */
export function shouldIgnoreEnterForSubmit(e) {
  if (e.key !== 'Enter') return false;
  return !!(e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229);
}
