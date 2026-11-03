import { useId } from 'react';
import type { FriendAppearance } from './friendDesign';

/** Local vector artwork; all palettes, variants and motion belong to CSS. */
export function FriendAvatar({ state = 'idle', appearance, preview = false }: {
  state?: 'idle' | 'listening' | 'working' | 'done'; appearance?: FriendAppearance; preview?: boolean;
}) {
  const id = useId(), body = `${id}-body`, accent = `${id}-accent`;
  if (appearance?.type === 'generated') return <div className="friend-avatar friend-avatar-generated" data-state={state} data-preview={preview} aria-hidden="true">
    <img className="friend-avatar-body" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(appearance.design.svg)}`} alt="" draggable={false}/>
  </div>;
  if (!appearance) return null;
  return <div className="friend-avatar" data-state={state} data-character={appearance.character} data-preview={preview} aria-hidden="true">
    <svg className="friend-avatar-art" viewBox="0 0 200 220" focusable="false">
      <defs>
        <linearGradient id={body} x1="0" y1="0" x2=".8" y2="1">
          <stop className="friend-coat-light" offset="0"/><stop className="friend-coat-middle" offset=".6"/><stop className="friend-coat-shade" offset="1"/>
        </linearGradient>
        <linearGradient id={accent} x1="0" y1="0" x2="1" y2="1">
          <stop className="friend-accent-light" offset="0"/><stop className="friend-accent-shade" offset="1"/>
        </linearGradient>
      </defs>
      <ellipse className="friend-avatar-shadow" cx="100" cy="194" rx="43" ry="7"/>
      <g className="friend-avatar-body">
        <g className="friend-avatar-ears friend-avatar-bunny" fill={`url(#${body})`}>
          <path d="M64 91C46 67 47 28 60 27C74 25 84 61 83 84Z"/>
          <path d="M113 82C115 50 131 22 143 28C155 35 142 74 133 93Z"/>
          <path className="friend-ear-inset" d="M63 76C55 54 56 39 60 39C65 38 73 61 74 78Z M123 76C128 52 138 39 140 42C144 45 135 67 131 81Z"/>
        </g>
        <g className="friend-avatar-ears friend-avatar-cat" fill={`url(#${body})`}>
          <path d="M55 100C48 82 47 47 55 43C62 40 83 62 88 76Z"/>
          <path d="M113 76C122 62 143 41 149 46C155 51 151 83 145 102Z"/>
          <path className="friend-ear-inset" d="M60 81L57 57Q70 62 76 79Z M125 79Q137 64 144 59L140 86Z"/>
        </g>
        <g className="friend-avatar-sprout" fill={`url(#${accent})`}>
          <path className="friend-sprout-stem" d="M100 80Q102 61 107 48"/>
          <path d="M105 62C80 63 77 43 79 39C94 37 107 44 105 62Z"/>
          <path d="M104 54C101 36 112 25 128 27C130 42 120 53 104 54Z"/>
          <path className="friend-leaf-vein" d="M104 59L86 46M106 49L121 34"/>
        </g>
        <g fill={`url(#${body})`}>
          <path className="friend-avatar-arm friend-avatar-arm-left" d="M55 118C41 113 34 132 38 142C41 150 51 148 61 135Z"/>
          <path className="friend-avatar-arm friend-avatar-arm-right" d="M143 119C156 111 167 123 166 135C165 148 152 148 140 136Z"/>
          <path className="friend-avatar-foot" d="M70 163C61 172 61 184 72 186C86 188 92 176 90 168Z M111 168C109 181 117 188 129 185C140 182 138 171 130 163Z"/>
          <path className="friend-avatar-coat" d="M100 71C72 67 57 84 53 112C49 130 46 143 54 158C63 174 83 178 101 178C122 178 140 173 148 156C156 140 151 125 148 108C145 84 128 68 100 71Z"/>
        </g>
        <ellipse className="friend-avatar-belly" cx="101" cy="151" rx="25" ry="17"/>
        <g className="friend-avatar-face">
          <ellipse className="friend-avatar-cheek" cx="70" cy="127" rx="9" ry="5"/>
          <ellipse className="friend-avatar-cheek" cx="132" cy="127" rx="9" ry="5"/>
          <g className="friend-avatar-eyes">
            <ellipse cx="80" cy="115" rx="4.3" ry="5.6"/><ellipse cx="122" cy="115" rx="4.3" ry="5.6"/>
            <circle className="friend-eye-light" cx="81.3" cy="113.2" r="1.3"/><circle className="friend-eye-light" cx="123.3" cy="113.2" r="1.3"/>
          </g>
          <path className="friend-avatar-happy" d="M76 116Q80 109 84 116M118 116Q122 109 126 116"/>
          <path className="friend-avatar-mouth" d="M95 127Q101 134 107 127"/>
          <path className="friend-avatar-whiskers" d="M61 119L70 122M61 130L70 128M132 122L141 119M132 128L141 130"/>
        </g>
        <path className="friend-avatar-seam" d="M93 155Q101 158 109 155"/>
      </g>
    </svg>
  </div>;
}
