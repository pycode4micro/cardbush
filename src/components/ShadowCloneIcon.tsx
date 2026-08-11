import { VenetianMask } from 'lucide-react';

export function ShadowCloneIcon({
  size = 16,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`shadow-clone-icon${className ? ` ${className}` : ''}`}
      style={{ width: size + 5, height: size }}
    >
      <VenetianMask className="shadow-clone-icon-back" size={Math.max(10, size - 2)} />
      <VenetianMask className="shadow-clone-icon-front" size={size} />
    </span>
  );
}
