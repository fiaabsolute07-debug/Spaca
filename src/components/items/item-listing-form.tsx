'use client';

import { useId, useState, type FormEvent } from 'react';
import { ITEM_COLLATERAL_MIN_DIVISOR, ITEM_CONFIRM_HOURS, ITEM_PAYMENT_HOURS, ITEM_TYPE_SUGGESTIONS, usd } from '@/lib/items';
import { TimeField } from '../time-field';
import { FormSteps } from '../form-steps';
import { FileUploadField } from '../files/file-upload-field';

const cents = (value: string) => (/^\d+(\.\d{1,2})?$/.test(value.trim()) ? Math.round(Number(value) * 100) : null);

/**
 * The listing form. It posts `create_item_listing` as JSON so a refusal keeps everything typed; without JavaScript it
 * is a plain form post and the server answers the same way.
 */
export function ItemListingForm({ idempotencyKey, canSellAsProject, defaults, moneyNote = null }: {
  idempotencyKey: string;
  canSellAsProject: boolean;
  /** Where the money is in this environment (sandbox, or payments not open yet); read on the server. */
  moneyNote?: string | null;
  /** Starting values as ISO instants: opens now, closes in 3 days, delivered within 7. */
  defaults: { startsAt: string; endsAt: string; deliveryDueAt: string };
}) {
  const id = useId();
  const [origin, setOrigin] = useState<'PROJECT' | 'RESALE'>(canSellAsProject ? 'PROJECT' : 'RESALE');
  const [itemType, setItemType] = useState('');
  const [starting, setStarting] = useState('');
  const [collateral, setCollateral] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startingCents = cents(starting);
  const floor = startingCents ? Math.ceil(startingCents / ITEM_COLLATERAL_MIN_DIVISOR) : null;
  const collateralCents = cents(collateral);
  const coverage = startingCents && collateralCents ? Math.round((collateralCents / startingCents) * 100) : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    // The picture field already stopped a submit that would leave an upload behind.
    const blocked = event.nativeEvent.defaultPrevented;
    event.preventDefault();
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/commands', { method: 'POST', body: new FormData(event.currentTarget), headers: { accept: 'application/json' } });
      const body = await response.json().catch(() => ({})) as { path?: string; error?: string };
      if (response.ok && body.path) {
        window.location.assign(body.path);
        return;
      }
      setError(body.error ?? 'The listing could not be created. Try again.');
    } catch {
      setError('Network error. Your answers are still here; try again.');
    }
    setBusy(false);
  }

  return <form className="items-form" method="post" action="/api/commands" onSubmit={submit}>
    <input type="hidden" name="command" value="create_item_listing" />
    <input type="hidden" name="idempotency_key" value={idempotencyKey} />
    <input type="hidden" name="return_to" value="/auctions/new" />

    {/* The three sections the form always had, asked one at a time: what it is, how it reaches the winner, how it sells. */}
    <FormSteps labels={['Item', 'Delivery', 'Auction']}>
    <section className="panel items-form-section" aria-labelledby={`${id}-what`}>
      <h2 id={`${id}-what`}>What you are selling</h2>
      <fieldset className="items-origin-choice">
        <legend>Who is selling</legend>
        <label className={`choice-card${origin === 'PROJECT' ? ' is-selected' : ''}${canSellAsProject ? '' : ' is-disabled'}`}>
          <input type="radio" name="origin" value="PROJECT" checked={origin === 'PROJECT'} disabled={!canSellAsProject} onChange={() => setOrigin('PROJECT')} />
          <strong>I’m the project</strong>
          <span>You issue this allocation. It shows as “Sold by the project”.{canSellAsProject ? '' : ' Needs a project (buyer) account.'}</span>
        </label>
        <label className={`choice-card${origin === 'RESALE' ? ' is-selected' : ''}`}>
          <input type="radio" name="origin" value="RESALE" checked={origin === 'RESALE'} onChange={() => setOrigin('RESALE')} />
          <strong>I’m reselling</strong>
          <span>You hold it and pass it on. It shows as “Resale”.</span>
        </label>
      </fieldset>

      <div className="field">
        <label htmlFor={`${id}-type`}>Item type <span className="items-optional">(optional)</span></label>
        <input id={`${id}-type`} name="item_type" value={itemType} onChange={(event) => setItemType(event.target.value)} maxLength={60}
          list={`${id}-types`} placeholder="WL spot, GTD mint, Pre-market token…" />
        <datalist id={`${id}-types`}>{ITEM_TYPE_SUGGESTIONS.map((type) => <option key={type} value={type} />)}</datalist>
        <div className="chip-row items-type-suggestions" aria-label="Common item types">
          {ITEM_TYPE_SUGGESTIONS.map((type) => <button key={type} type="button" className={`chip-link${itemType === type ? ' is-picked' : ''}`} aria-pressed={itemType === type} onClick={() => setItemType(type)}>{type}</button>)}
        </div>
        <small>Pick one or write your own: anything the winner can receive.</small>
      </div>
      <div className="field">
        <label htmlFor={`${id}-title`}>Title</label>
        <input id={`${id}-title`} name="title" required maxLength={200} placeholder="Arcadia genesis mint, 1 WL spot" />
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${id}-project`}>Project <span className="items-optional">(optional)</span></label>
          <input id={`${id}-project`} name="project_name" maxLength={120} placeholder="Arcadia" />
        </div>
        <div className="field">
          <label htmlFor={`${id}-url`}>Project link <span className="items-optional">(optional)</span></label>
          <input id={`${id}-url`} name="project_url" maxLength={300} placeholder="https://x.com/arcadia" autoCapitalize="none" spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-network`}>Network <span className="items-optional">(optional)</span></label>
          <input id={`${id}-network`} name="network" maxLength={60} placeholder="Base, Solana, Ethereum…" />
        </div>
        <div className="field">
          <label htmlFor={`${id}-quantity`}>Quantity <span className="items-optional">(optional)</span></label>
          <input id={`${id}-quantity`} name="quantity" maxLength={120} placeholder="1 spot, 5,000 $ARC, 1,200 points" />
        </div>
      </div>
      <FileUploadField purpose="ITEM_IMAGE" name="image_ids" label="Pictures (optional)" maxFiles={6}
        help="Up to 6: the art, the project banner, a screenshot of the allowlist. The first is the cover; PNG, JPG, GIF or WebP up to 10 MB." />
      <div className="field">
        <label htmlFor={`${id}-description`}>Description <span className="items-optional">(optional)</span></label>
        <textarea id={`${id}-description`} name="description" rows={4}
          placeholder="What exactly the winner gets, the mint or TGE date, price at mint, and any conditions from the project." />
      </div>
    </section>

    <section className="panel items-form-section" aria-labelledby={`${id}-delivery`}>
      <h2 id={`${id}-delivery`}>Delivery</h2>
      <div className="field">
        <label htmlFor={`${id}-method`}>How the winner receives it <span className="items-optional">(optional)</span></label>
        <textarea id={`${id}-method`} name="delivery_method" rows={3}
          placeholder="The project adds the winner's wallet to the allowlist before the mint on Oct 12." />
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${id}-provides`}>What the winner must give you <span className="items-optional">(optional)</span></label>
          <input id={`${id}-provides`} name="buyer_provides" maxLength={500} placeholder="EVM wallet address" />
        </div>
        <TimeField name="delivery_due_at" label="Deliver by" value={defaults.deliveryDueAt}
          help="Miss it and the buyer is refunded with your collateral." />
      </div>
    </section>

    <section className="panel items-form-section" aria-labelledby={`${id}-auction`}>
      <h2 id={`${id}-auction`}>Auction</h2>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${id}-start-price`}>Starting price (USD)</label>
          <input id={`${id}-start-price`} name="starting_price" type="number" min="0.01" step="0.01" inputMode="decimal" required value={starting} onChange={(event) => setStarting(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-increment`}>Minimum increment (USD)</label>
          <input id={`${id}-increment`} name="min_increment" type="number" min="0.01" step="0.01" inputMode="decimal" defaultValue="5" />
        </div>
        <div className="field">
          <label htmlFor={`${id}-buy-now`}>Buy now price <span className="items-optional">(optional)</span></label>
          <input id={`${id}-buy-now`} name="buy_now_price" type="number" min="0.01" step="0.01" inputMode="decimal" />
          <small>Available until the first bid.</small>
        </div>
        <div className="field">
          <label htmlFor={`${id}-collateral`}>Your collateral (USD)</label>
          <input id={`${id}-collateral`} name="collateral" type="number" min="0.01" step="0.01" inputMode="decimal" value={collateral} onChange={(event) => setCollateral(event.target.value)} />
          <small>{floor ? `At least ${usd(floor)}, a fifth of the starting price.` : 'At least a fifth of the starting price.'}{coverage !== null ? ` Covers ${coverage}% of the starting price.` : ''}</small>
        </div>
        <TimeField name="starts_at" label="Bidding opens" value={defaults.startsAt} />
        <TimeField name="ends_at" label="Bidding closes" required value={defaults.endsAt} help="Up to 14 days after it opens." />
      </div>
      <p className="items-form-terms">The winner pays into escrow within {ITEM_PAYMENT_HOURS} hours. After you mark the item delivered, the buyer has {ITEM_CONFIRM_HOURS} hours to confirm or dispute; silence counts as confirmed.{moneyNote ? ` ${moneyNote}` : ''}</p>
    </section>
    </FormSteps>

    <div className="items-form-actions">
      {error && <p className="items-form-error" role="alert">{error}</p>}
      <button className="button button-dark" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create listing'}</button>
    </div>
  </form>;
}
