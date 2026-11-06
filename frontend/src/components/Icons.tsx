// One stroke family: 24px viewBox, 1.7px stroke, round caps and joins.
const PATHS: Record<string, string[]> = {
  discover: ['m12 2 2.6 6.8L22 12l-7.4 2.8L12 22l-2.6-7.2L2 12l7.4-3.2Z'],
  ghost: ['M5 21V10a7 7 0 0 1 14 0v11l-3.5-2-3.5 2-3.5-2Z', 'M9 10v2m6-2v2'],
  matches: ['M12 21 3.5 12A5.3 5.3 0 0 1 12 5.8 5.3 5.3 0 0 1 20.5 12Z'],
  leaderboards: ['M4 21V11h4v10M10 21V4h4v17M16 21v-7h4v7'],
  trades: ['M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4'],
  bots: ['M7 7h10a3 3 0 0 1 3 3v8H4v-8a3 3 0 0 1 3-3Z', 'M9 11v2m6-2v2M9 18v3m6-3v3M12 3v4M1 11h3m16 0h3'],
  you: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4 21v-2a8 8 0 0 1 16 0v2'],
  x: ['m6 6 12 12M6 18 18 6'],
  star: ['m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z'],
  arrow: ['M4 12h16m-6-6 6 6-6 6'],
  shield: ['m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z', 'm8 12 3 3 5-6'],
  filter: ['M4 7h16M4 17h16M8 4v6m8 4v6'],
  external: ['M14 4h6v6', 'M20 4 10 14', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
  chevron: ['m9 6 6 6-6 6'],
  check: ['m5 12 4 4L19 6'],
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
};

export function Icon({ name, size = 24 }: { name: string; size?: number }) {
  const paths = PATHS[name === 'ghosts' ? 'ghost' : name];
  if (!paths) return null;
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

export default Icon;
