'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { Children } from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * One long form, asked a few questions at a time — a campaign brief, an auction listing. Every step stays in the same form and stays mounted, so nothing
 * typed is lost when moving back and nothing is submitted twice; a step that is not showing is hidden, not unmounted.
 *
 * Moving on checks the fields of the step you are leaving, so the browser never has to complain about a required box
 * it cannot scroll to: by the time the last step is reached, everything behind it is already filled. The form's own
 * submit button belongs to the last step, and `data-last` hides it before then (see `.form-steps` in globals.css).
 *
 * Each step must arrive as one element, not a fragment: `Children.toArray` flattens a fragment into its children and
 * every line of the step would become a step of its own.
 */
export function FormSteps({ labels, children }: { labels: string[]; children: ReactNode }) {
  const panels = Children.toArray(children);
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const id = useId();
  const last = step === panels.length - 1;

  /** True when every field in the step answers for itself; the first that does not says so and takes the focus. */
  const stepIsComplete = (index: number) => {
    const panel = refs.current[index];
    if (!panel) return true;
    for (const field of panel.querySelectorAll<HTMLInputElement>('input, select, textarea')) {
      if (!field.checkValidity()) {
        field.reportValidity();
        return false;
      }
    }
    return true;
  };

  const go = (next: number) => {
    if (next > step && !stepIsComplete(step)) return;
    setStep(next);
    setFurthest((seen) => Math.max(seen, next));
    refs.current[next]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  return <div className="form-steps" data-last={last}>
    <ol className="form-steps-rail" aria-label="Steps">
      {labels.map((label, index) => {
        const done = index < furthest && index !== step;
        return <li key={label} className={`form-step-dot${index === step ? ' is-current' : ''}${done ? ' is-done' : ''}`}>
          {/* A step already reached can be reopened; one still ahead waits until the steps before it are answered. */}
          <button type="button" onClick={() => go(index)} disabled={index > furthest}
            aria-current={index === step ? 'step' : undefined} aria-controls={`${id}-${index}`}>
            <span className="form-step-mark" aria-hidden>{done ? <Check size={12} strokeWidth={3} /> : index + 1}</span>
            <span className="form-step-label">{label}</span>
          </button>
        </li>;
      })}
    </ol>

    {panels.map((panel, index) => <div key={labels[index] ?? index} id={`${id}-${index}`} hidden={index !== step}
      ref={(node) => { refs.current[index] = node; }}>
      {panel}
    </div>)}

    <div className="form-steps-nav">
      {step > 0 && <button type="button" className="button button-outline" onClick={() => go(step - 1)}>
        <ChevronLeft size={16} aria-hidden /> Back
      </button>}
      <span className="form-steps-count">Step {step + 1} of {panels.length}</span>
      {!last && <button type="button" className="button" onClick={() => go(step + 1)}>
        Next <ChevronRight size={16} aria-hidden />
      </button>}
    </div>
  </div>;
}
