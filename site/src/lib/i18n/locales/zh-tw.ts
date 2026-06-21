import type { Dict } from '../types';
import { zh } from './zh';
import * as OpenCC from 'opencc-js';

// 繁體中文由簡體 zh 在「建置期」用 OpenCC（cn → twp：簡體 → 臺灣正體含詞彙轉換）
// 自動轉換而來。站點是純靜態 SSG，這段只在 build 時跑一次，零執行期成本，
// 且永遠與 zh 保持同步——無需手動維護一份繁體檔案。
const convert = OpenCC.Converter({ from: 'cn', to: 'twp' });

/** 深層轉換 dict：字串走 OpenCC，物件 / 陣列遞迴，其餘原樣返回。 */
function deepConvert<T>(value: T): T {
  if (typeof value === 'string') return convert(value) as T;
  if (Array.isArray(value)) return value.map((v) => deepConvert(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepConvert(v);
    return out as T;
  }
  return value;
}

export const zhTW: Dict = deepConvert(zh);
