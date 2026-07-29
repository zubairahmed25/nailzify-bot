/**
 * The launcher avatar.
 *
 * ⚠️ THE SOURCE FILE COULD NOT BE USED AS EXPORTED, in two ways that both fail
 * silently rather than loudly.
 *
 * Its viewBox was "0 0 680 340" while the artwork occupies only the middle
 * ~256x256. Rendered into a 70px button that scales the avatar to about 26px —
 * a correct-looking SVG that is simply mostly empty space.  Cropped here to the
 * outer ring: centre (340,170), radius 126 plus a 4px stroke, so 212 42 256 256.
 *
 * And every element carried a `style` attribute full of font-family and
 * stroke-linejoin defaults — 5.4KB of exporter noise out of 6.9KB, none of it
 * load-bearing. Stripped.
 *
 * The artwork brings its own circle and pink ring, so the launcher button is
 * transparent behind it. A pink button under a pink ring reads as a smudge.
 */
export function AgentAvatar() {
  return (
    <svg viewBox="212 42 256 256" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs><clipPath id="ring"><circle cx="340" cy="170" r="126"/></clipPath></defs>
      <circle cx="340" cy="170" r="126" fill="#FFF1F5"/>
      <g clip-path="url(#ring)"><ellipse cx="340" cy="150" rx="58" ry="60" fill="#2F2A33"/><rect x="328" y="180" width="24" height="42" fill="#EBCE96"/><path d="M270 300 L270 258 Q272 234 306 224 L374 224 Q408 234 410 258 L410 300 Z" fill="#F3AFC0"/><path d="M320 224 L340 250 L360 224 L360 300 L320 300 Z" fill="#FBD9E1"/><path d="M320 224 L340 250 L360 224" fill="none" stroke="#E794AA" stroke-width="1.5"/><rect x="292" y="266" width="32" height="7" rx="3" fill="#FBD9E1"/><ellipse cx="340" cy="148" rx="42" ry="48" fill="#F7E3B0"/><path d="M298 132 Q300 96 340 96 Q380 96 382 132 Q361 118 340 118 Q319 118 298 132 Z" fill="#2F2A33"/><path d="M296 126 Q340 68 384 126" fill="none" stroke="#FF80AA" stroke-width="7" stroke-linecap="round"/><ellipse cx="296" cy="137" rx="12.5" ry="16.5" fill="#FF80AA"/><path d="M296 153 Q304 200 328 204" fill="none" stroke="#FF80AA" stroke-width="5" stroke-linecap="round"/><circle cx="333" cy="205" r="6.5" fill="#FF80AA"/></g>
      <circle cx="340" cy="170" r="126" fill="none" stroke="#FF80AA" stroke-width="4"/>
    </svg>
  );
}
