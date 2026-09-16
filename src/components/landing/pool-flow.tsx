import styles from './landing.module.css';

const PATHS = ['M178 150 C 260 150, 300 62, 392 62', 'M178 150 C 270 150, 310 150, 392 150', 'M178 150 C 260 150, 300 238, 392 238'];
const RETURN = 'M108 188 C 108 250, 140 272, 200 272';

/**
 * Reward pools as a moving diagram: a campaign pool sends a share to each creator only when that creator's work is
 * approved (a check appears as the share lands), and what was not used flows back. Illustration only: pools run on
 * testnet and hold no real funds, as the tile beside it says.
 */
export function PoolFlow() {
  return <svg className={styles.flow} viewBox="0 0 520 300" role="img" aria-labelledby="pool-flow-title">
    <title id="pool-flow-title">A reward pool pays each creator when their work is approved, and returns what was not used</title>
    {PATHS.map((d) => <path key={d} className={styles.flowPath} d={d} />)}
    <path className={`${styles.flowPath} ${styles.flowReturn}`} d={RETURN} />

    <rect className={styles.flowPool} x="38" y="112" width="140" height="76" />
    <text className={styles.flowLabel} x="108" y="145" textAnchor="middle">Reward pool</text>
    <text className={styles.flowValue} x="108" y="168" textAnchor="middle">USDC · testnet</text>

    <rect className={styles.flowNode} x="200" y="252" width="96" height="40" />
    <text className={styles.flowLabel} x="248" y="276" textAnchor="middle">Back to you</text>

    {[62, 150, 238].map((y, index) => <g key={y}>
      <circle className={styles.flowNode} cx="416" cy={y} r="22" />
      <text className={styles.flowLabel} x="416" y={y + 4} textAnchor="middle">C{index + 1}</text>
      <path className={styles.flowCheck} d={`M446 ${y}l6 6 12-13`}>
        <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.62;0.7;0.92;1" dur="3.6s" begin={`${index * 1.2}s`} repeatCount="indefinite" />
      </path>
      <circle className={styles.flowToken} r="5">
        <animateMotion dur="3.6s" begin={`${index * 1.2}s`} repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;0.66;1" calcMode="linear" path={PATHS[index]} />
      </circle>
    </g>)}
    <circle className={`${styles.flowToken} ${styles.flowTokenReturn}`} r="4">
      <animateMotion dur="3.6s" begin="2.4s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;0.6;1" calcMode="linear" path={RETURN} />
    </circle>
  </svg>;
}
