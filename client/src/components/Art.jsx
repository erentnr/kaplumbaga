// The turtle and the small icons, drawn inline so they take the page's colors
// and load with the code.
const INK = '#1E2B1A'
const SKIN = '#6FB043'
const SHELL = '#F2C94C'
const SCUTE = '#E0A928'

// `detailed` adds the eye highlight, a smile and the side scutes, for the
// big turtle on the home page. The small one stays readable at 36px wide.
export const Turtle = ({ detailed = false, ...props }) => {
  const line = { stroke: INK, strokeWidth: detailed ? 3 : 4, strokeLinejoin: 'round' }
  const inner = { stroke: INK, strokeWidth: detailed ? 2.5 : 3, strokeLinejoin: 'round' }
  return (
    <svg viewBox="0 0 120 76" aria-hidden="true" {...props}>
      <path d="M15 52 L3 57 L16 59 Z" fill={SKIN} {...line} />
      <rect x="24" y="48" width="14" height="22" rx="7" fill={SKIN} {...line} />
      <rect x="70" y="48" width="14" height="22" rx="7" fill={SKIN} {...line} />
      <rect x="80" y="38" width="20" height="16" rx="7" fill={SKIN} {...line} />
      <ellipse cx="102" cy="38" rx="14" ry="12" fill={SKIN} {...line} />
      <circle cx="106" cy="34" r={detailed ? 3.6 : 4} fill={INK} />
      {detailed && (
        <>
          <circle cx="107.3" cy="32.7" r="1.2" fill="#fff" />
          <path d="M104 43 Q109 46.5 113 42" fill="none" stroke={INK} strokeWidth="2.5" strokeLinecap="round" />
        </>
      )}
      <path d="M16 54 C18 22 38 10 54 10 C72 10 90 24 92 54 Z" fill={SHELL} {...line} />
      <path d="M45 22 L61 22 L68 35 L61 48 L45 48 L38 35 Z" fill={SCUTE} {...inner} />
      {detailed && (
        <>
          <path d="M23 50 C24 41 28 35 33 30 L38 35 L34 50 Z" fill={SCUTE} {...inner} />
          <path d="M85 50 C84 41 80 35 75 30 L68 35 L72 50 Z" fill={SCUTE} {...inner} />
        </>
      )}
      <rect x="10" y="50" width="88" height="8" rx="4" fill={SKIN} {...line} />
    </svg>
  )
}

// on its back with its legs waving, for a room that can't be joined
export const TurtleOnBack = (props) => {
  const line = { stroke: INK, strokeWidth: 3, strokeLinejoin: 'round' }
  return (
    <svg viewBox="0 0 120 90" role="img" aria-label="A turtle on its back, legs waving" {...props}>
      <g transform="rotate(180 60 42)">
        <path d="M15 52 L3 57 L16 59 Z" fill={SKIN} {...line} />
        <rect x="24" y="48" width="14" height="22" rx="7" fill={SKIN} {...line} transform="rotate(-12 31 50)" />
        <rect x="70" y="48" width="14" height="22" rx="7" fill={SKIN} {...line} transform="rotate(14 77 50)" />
        <path d="M16 54 C18 22 38 10 54 10 C72 10 90 24 92 54 Z" fill={SHELL} {...line} />
        <path d="M45 22 L61 22 L68 35 L61 48 L45 48 L38 35 Z" fill={SCUTE} {...line} strokeWidth="2.5" />
        <rect x="10" y="50" width="88" height="8" rx="4" fill={SKIN} {...line} />
      </g>
      <rect x="14" y="26" width="18" height="14" rx="6" fill={SKIN} {...line} />
      <ellipse cx="13" cy="37" rx="12" ry="10" fill={SKIN} {...line} />
      <path d="M6 33 l4 4 M10 33 l-4 4 M14 33 l4 4 M18 33 l-4 4" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M0 77 H120" stroke="#9DA394" strokeWidth="3" strokeDasharray="6 6" />
    </svg>
  )
}

export const Crown = (props) => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" {...props}>
    <path d="M3 8l4.5 3.5L12 5l4.5 6.5L21 8l-2 11H5z" fill={SHELL} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
  </svg>
)

export const Eye = (props) => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" {...props}>
    <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" fill="#fff" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="3.2" fill={INK} />
  </svg>
)

export const Alert = (props) => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="10" fill="#8C311C" />
    <path d="M12 7v6M12 16.5v.5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
  </svg>
)

export const Chevron = (props) => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" {...props}>
    <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
