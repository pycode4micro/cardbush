// Original connector geometry for CardBush, inspired by a reversible USB-C port.
export function PluginIcon({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      className={`plugin-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.5" y="6.5" width="19" height="11" rx="5.5" />
      <rect x="7" y="10.5" width="10" height="3" rx="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
