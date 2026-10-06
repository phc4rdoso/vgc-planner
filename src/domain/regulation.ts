/** The ruleset the tool currently supports. Add more entries here when new regulations arrive. */
export const REGULATION = {
  id: 'MC',
  label: 'Reg M-C',
  /** Team rule used for warnings (not enforced). */
  maxMegas: 2,
  teamSize: 6,
} as const;
