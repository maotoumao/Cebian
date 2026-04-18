/**
 * Thin re-export of `@wxt-dev/i18n`'s `t` function.
 *
 * All Cebian source code MUST import `t` from here, never from `#i18n`
 * directly. This indirection lets a future migration to a different i18n
 * library (e.g. react-i18next) be a single-file change.
 *
 * See `.agents/skills/i18n-naming/SKILL.md` for naming, placeholder, and
 * pluralization conventions.
 */
import { i18n } from '#i18n';

export const t = i18n.t;
