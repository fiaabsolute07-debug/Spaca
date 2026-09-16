'use client';

import { useEffect, useState, type CSSProperties, type PointerEvent } from 'react';
import { useInView, usePrefersReducedMotion } from './in-view';
import styles from './landing.module.css';

const STEPS = [
  { label: 'Brief', title: 'Post one brief', text: 'Say what launches, how many creators you need and the budget. Creators apply with samples and a quote, and you hire the ones who fit.', facts: ['One brief, many hires', 'Budget held per hire'] },
  { label: 'Post', title: 'Creators deliver', text: 'Drafts, files and post links arrive in one workspace per order, every version kept. Sponsored posts carry their disclosure.', facts: ['One revision included', 'Deadline starts with the brief'] },
  { label: 'Paid', title: 'Approve, then release', text: 'Approve the delivery and that creator is paid. Whatever the campaign did not use stays with you.', facts: ['Paid on approval', 'Disputes reviewed by people'] },
];
const AUTO_MS = 4200;
const LAYERS = 9;

/**
 * "How it works" as the logo itself: three slanted bars stacked in 3D, one per step. The stack tilts with the
 * pointer, a bar lifts when its step is chosen, and the steps advance on their own until someone takes over.
 * The step list is the accessible control; the 3D stack is a mirror of it.
 */
export function LaunchStack() {
  const [active, setActive] = useState(0);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [touched, setTouched] = useState(false);
  const reduced = usePrefersReducedMotion();
  const { ref, inView } = useInView<HTMLDivElement>('0px');

  useEffect(() => {
    if (touched || reduced || !inView) return;
    const timer = window.setInterval(() => setActive((step) => (step + 1) % STEPS.length), AUTO_MS);
    return () => window.clearInterval(timer);
  }, [touched, reduced, inView]);

  const choose = (index: number) => { setTouched(true); setActive(index); };
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    if (reduced || event.pointerType !== 'mouse') return;
    const box = event.currentTarget.getBoundingClientRect();
    setTilt({ x: (event.clientX - box.left) / box.width - 0.5, y: (event.clientY - box.top) / box.height - 0.5 });
  };
  const step = STEPS[active]!;

  return <div ref={ref} className={styles.howGrid}>
    <div>
      <p className={styles.kicker}>How it works</p>
      <h2 className={styles.h2}>Three bars. One campaign.</h2>
      <div className={styles.howSteps} role="tablist" aria-label="How a campaign moves" aria-orientation="vertical">
        {STEPS.map((item, index) => <button key={item.label} type="button" role="tab" id={`how-tab-${index}`} aria-controls="how-panel"
          aria-selected={active === index} className={styles.howStep} onClick={() => choose(index)}>
          <span className={styles.howStepNo}>0{index + 1}</span>
          <span>
            <span className={styles.howStepTitle}>{item.title}</span>
            {active === index && <span className={styles.howStepText}>{item.text}</span>}
            {active === index && !touched && !reduced && <span key={active} className={styles.howProgress} style={{ '--ms': `${AUTO_MS}ms` } as CSSProperties} aria-hidden />}
          </span>
        </button>)}
      </div>
      <div id="how-panel" role="tabpanel" aria-labelledby={`how-tab-${active}`} className={styles.howFacts} aria-live="polite">
        {step.facts.map((fact) => <span key={fact}>{fact}</span>)}
      </div>
    </div>

    <div className={styles.stackScene} onPointerMove={onMove} onPointerLeave={() => setTilt({ x: 0, y: 0 })} aria-hidden>
      <div className={styles.stackShadow} />
      <div className={styles.stackStage} style={{ '--rx': `${tilt.y * -14}deg`, '--rz': `${tilt.x * 18}deg` } as CSSProperties}>
        {STEPS.map((item, index) => <div key={item.label} className={styles.slab} data-active={active === index || undefined}
          style={{ '--i': index } as CSSProperties} onClick={() => choose(index)}>
          {Array.from({ length: LAYERS }, (_, depth) => <span key={depth} className={styles.slabLayer} style={{ '--d': depth + 1 } as CSSProperties} />)}
          <span className={styles.slabTop}><small>0{index + 1}</small>{item.label}</span>
        </div>)}
      </div>
    </div>
  </div>;
}
