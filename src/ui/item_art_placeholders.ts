/** Temporary art reuse ledger. Aliases remain in ITEM_ART_PENDING until their own art lands. */
export const ITEM_ART_PLACEHOLDERS: Readonly<Record<string, string>> = {
  // The carried foreign keepsake uses a curio icon until its dedicated painting lands.
  ps_keepsake: 'guardian_core',
};
