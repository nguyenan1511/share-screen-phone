// iPhone screens, portrait. Points = what iOS lays out in; pixels = the physical panel.
// Models that share a screen are grouped. Sources: Apple tech specs, iosref.com/res (checked 2026-10).
export const PHONES = [
  { id: 'pro-max-6.9', name: 'iPhone 18 Pro Max, 17 Pro Max, 16 Pro Max', points: [440, 956], pixels: [1320, 2868] },
  { id: 'pro-6.3', name: 'iPhone 18 Pro, 17 Pro, 17, 16 Pro', points: [402, 874], pixels: [1206, 2622] },
  { id: 'air', name: 'iPhone Air', points: [420, 912], pixels: [1260, 2736] },
  { id: 'max-6.7', name: 'iPhone 16 Plus, 15 Pro Max, 15 Plus, 14 Pro Max', points: [430, 932], pixels: [1290, 2796] },
  { id: 'std-6.1-dyn', name: 'iPhone 16, 15 Pro, 15, 14 Pro', points: [393, 852], pixels: [1179, 2556] },
  { id: 'max-6.7-notch', name: 'iPhone 14 Plus, 13 Pro Max, 12 Pro Max', points: [428, 926], pixels: [1284, 2778] },
  { id: 'std-6.1', name: 'iPhone 17e, 16e, 14, 13, 13 Pro, 12, 12 Pro', points: [390, 844], pixels: [1170, 2532] },
  { id: 'mini', name: 'iPhone 13 mini, 12 mini', points: [375, 812], pixels: [1080, 2340] },
  { id: 'max-6.5', name: 'iPhone 11 Pro Max, XS Max', points: [414, 896], pixels: [1242, 2688] },
  { id: 'xr', name: 'iPhone 11, XR', points: [414, 896], pixels: [828, 1792] },
  { id: 'x', name: 'iPhone 11 Pro, XS, X', points: [375, 812], pixels: [1125, 2436] },
  { id: 'plus', name: 'iPhone 8 Plus, 7 Plus, 6s Plus, 6 Plus', points: [414, 736], pixels: [1080, 1920] },
  { id: 'se', name: 'iPhone SE (2nd, 3rd gen), 8, 7, 6s, 6', points: [375, 667], pixels: [750, 1334] },
];

// What Safari reports: points × the whole-number scale iOS renders at. For most phones that is the panel,
// but the minis and the Plus models render at 3x and then scale down (1125×2436 shown on a 1080×2340 panel).
const rendered = (p) => p.points.map((n) => n * Math.round(p.pixels[0] / p.points[0]));

// The phone reports its screen (points × devicePixelRatio); find the model group, any orientation.
// Some groups look identical from a web page (12 mini vs X): then the names are joined with "or".
export function detectPhone(viewport) {
  if (!viewport) return null;
  const long = Math.max(viewport.w, viewport.h);
  const short = Math.min(viewport.w, viewport.h);
  const matches = PHONES.filter((p) => {
    const [w, h] = rendered(p);
    return Math.abs(h - long) <= 4 && Math.abs(w - short) <= 4;
  });
  if (!matches.length) return null;
  return { ...matches[0], name: matches.map((p) => p.name).join(' or ') };
}

// Size of the iPhone screen to create, in points, for a phone + text size + orientation.
//   small:  half the phone's pixels, shown HiDPI → exactly one stream pixel per phone pixel (sharpest, most room)
//   large:  the phone's own points → text as big as the iPhone's own UI
//   medium: in between
export function screenFor(phone, textSize, portrait) {
  const small = phone.pixels.map((n) => n / 2);
  const large = phone.points;
  const pick = { small, large, medium: small.map((n, i) => (n + large[i]) / 2) }[textSize] ?? small;
  const even = (n) => Math.round(n / 2) * 2;
  const [w, h] = pick.map(even);
  return portrait ? [w, h] : [h, w];
}
