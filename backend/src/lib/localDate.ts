/** Today's date as YYYY-MM-DD in the CONTAINER's timezone (TZ, pinned to Europe/Berlin in the
 *  Dockerfile), not in UTC.
 *
 *  The obvious `new Date().toISOString().slice(0, 10)` does NOT do this: toISOString is always
 *  UTC by definition, whatever TZ says. That was harmless while the container also ran on UTC —
 *  the two agreed — but the container is now on local time, so between 00:00 and 02:00 Berlin
 *  (01:00 in winter) the UTC date is still YESTERDAY. Every "what is today" caller would then
 *  disagree with `new Date()`'s own getFullYear/getMonth/getDate, which are local.
 *
 *  Concretely, that window is exactly when it matters: a receipt dropped in the folder or mailed
 *  in just after midnight would be filed to the previous day, and the OCR prompt would be told
 *  the wrong "today" while resolving a relative date on the receipt itself.
 *
 *  'sv-SE' is used only because Swedish formats dates as YYYY-MM-DD; it is a formatting trick,
 *  not a locale choice, and it is stable across Node versions and ICU builds. */
export function todayLocal(d: Date = new Date()): string {
  return d.toLocaleDateString('sv-SE');
}

/** Same conversion for an arbitrary Date — e.g. a parsed e-mail header, where the instant is
 *  known but the calendar day must be the household's, not UTC's. */
export const localDay = (d: Date): string => d.toLocaleDateString('sv-SE');
