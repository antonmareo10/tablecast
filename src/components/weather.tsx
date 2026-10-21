// Small weather glyphs in the brand palette (replacing platform emoji, which render differently everywhere).
// Decorative: the condition is always written next to them.

export type WeatherKind = "sun" | "partly" | "cloud" | "fog" | "drizzle" | "rain" | "heavy" | "snow" | "thunder";

const KINDS: [RegExp, WeatherKind][] = [
  [/thunder/, "thunder"],
  [/snow/, "snow"],
  [/heavy rain|showers/, "heavy"],
  [/drizzle/, "drizzle"],
  [/rain/, "rain"],
  [/fog/, "fog"],
  [/partly/, "partly"],
  [/overcast|cloudy/, "cloud"],
  [/clear|sun/, "sun"],
];

export function weatherKind(condition: string): WeatherKind {
  const c = condition.toLowerCase();
  return KINDS.find(([re]) => re.test(c))?.[1] ?? "partly";
}

const CLOUD = "M7.2 18.5h9.6a3.9 3.9 0 0 0 .5-7.77 5.3 5.3 0 0 0-10.17 1.1A3.35 3.35 0 0 0 7.2 18.5Z";

export function WeatherIcon({ condition, size = 24, className = "" }: { condition: string; size?: number; className?: string }) {
  const kind = weatherKind(condition);
  const cloud = <path d={CLOUD} fill="var(--card)" stroke="var(--ink-2)" strokeWidth="1.4" strokeLinejoin="round" />;
  const drops = (n: number, heavy = false) =>
    Array.from({ length: n }, (_, i) => {
      const x = 8.5 + i * (n > 2 ? 3 : 4.5);
      return <path key={i} d={`M${x} 20.2l-0.9 2.1`} stroke="var(--olive-2)" strokeWidth={heavy ? 1.8 : 1.4} strokeLinecap="round" />;
    });
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      {kind === "sun" && (
        <g stroke="var(--saffron)" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="4.2" fill="var(--saffron)" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <path key={a} d="M12 3.2v2" transform={`rotate(${a} 12 12)`} />
          ))}
        </g>
      )}
      {kind === "partly" && (
        <>
          <g stroke="var(--saffron)" strokeWidth="1.4" strokeLinecap="round">
            <circle cx="9" cy="8.6" r="3.4" fill="var(--saffron)" />
            {[0, 60, 120, 300].map((a) => (
              <path key={a} d="M9 2.6v1.3" transform={`rotate(${a} 9 8.6)`} />
            ))}
          </g>
          {cloud}
        </>
      )}
      {kind === "cloud" && (
        <>
          <path d="M10.5 9.6a4.4 4.4 0 0 1 8.1 1.5" stroke="var(--muted)" strokeWidth="1.2" strokeLinecap="round" />
          {cloud}
        </>
      )}
      {kind === "fog" && (
        <g stroke="var(--ink-2)" strokeWidth="1.5" strokeLinecap="round">
          <path d="M4 9h16M6 13h12M4 17h16" opacity="0.8" />
        </g>
      )}
      {(kind === "drizzle" || kind === "rain" || kind === "heavy" || kind === "snow" || kind === "thunder") && (
        <g transform="translate(0 -2.4)">{cloud}</g>
      )}
      {kind === "drizzle" && drops(2)}
      {kind === "rain" && drops(3)}
      {kind === "heavy" && drops(4, true)}
      {kind === "snow" &&
        [8.5, 12, 15.5].map((x) => <circle key={x} cx={x} cy="20.4" r="1" fill="var(--ink-2)" />)}
      {kind === "thunder" && <path d="M12.6 15.2l-2.2 3.6h2.6l-1.6 3.4" stroke="var(--saffron)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
