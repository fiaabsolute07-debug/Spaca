'use client';

import { useState } from 'react';
import { CATEGORIES } from '../category';

const PLATFORMS: [string, string][] = [['X', 'X'], ['INSTAGRAM', 'Instagram'], ['TIKTOK', 'TikTok'], ['YOUTUBE', 'YouTube'], ['NEWSLETTER', 'Newsletter'], ['WEBSITE', 'Website']];
const FORMATS: [string, string][] = [['POST', 'Post'], ['THREAD', 'Thread'], ['QUOTE_POST', 'Quote post'], ['VIDEO', 'Video'], ['NEWSLETTER_ISSUE', 'Newsletter issue'], ['ARTICLE', 'Article']];

function Chips({ name, legend, options, value, onChange }: { name: string; legend: string; options: [string, string][]; value: string; onChange: (next: string) => void }) {
  return <fieldset className="choice-group">
    <legend>{legend}</legend>
    <div className="choice-chips">
      {options.map(([option, label]) => <label key={option} className="choice-chip">
        <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} />
        <span>{label}</span>
      </label>)}
    </div>
  </fieldset>;
}

const usd = (value: string) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
};

/**
 * What the campaign is asking for, and how it pays. Only the fields that apply are rendered, so a campaign never
 * submits posting terms or a view bonus it does not use. Performance (master §9.6) is a fixed fee per post plus a
 * bonus for measured views, capped in two ways: per thousand views up to a cap, and never above the creator's own
 * recent median times the multiplier.
 */
export function BriefTypePicker({ performanceEnabled }: { performanceEnabled: boolean }) {
  const [taxonomy, setTaxonomy] = useState(CATEGORIES[0]!.value);
  const [platform, setPlatform] = useState('X');
  const [format, setFormat] = useState('POST');
  const [paymentModel, setPaymentModel] = useState('FIXED');
  const [baseFee, setBaseFee] = useState('20');
  const [rpmRate, setRpmRate] = useState('2');
  const [bonusCap, setBonusCap] = useState('80');

  const publish = taxonomy === 'PUBLISH';
  const performance = publish && performanceEnabled && paymentModel === 'PERFORMANCE';
  const maxPerHire = usd(baseFee) + usd(bonusCap);

  return <>
    <fieldset className="choice-group">
      <legend>What do you need?</legend>
      <div className="choice-cards">
        {CATEGORIES.map((category) => <label key={category.value} className={`choice-card cat-${category.key}`}>
          <input type="radio" name="taxonomy" value={category.value} checked={taxonomy === category.value} onChange={() => setTaxonomy(category.value)} required />
          <span className="choice-icon">{category.icon}</span>
          <strong>{category.title}</strong>
          <small>{category.need}</small>
        </label>)}
      </div>
    </fieldset>

    {publish && <div className="publish-block">
      <h3 className="brief-section">How creators post for you</h3>
      <p className="muted">Each creator posts on their own account, in their own words, with a sponsorship disclosure. Briefs that ask to hide the sponsorship, fake engagement or promise returns are refused.</p>
      <Chips name="publish_platform" legend="Platform" options={PLATFORMS} value={platform} onChange={setPlatform} />
      <Chips name="publish_format" legend="Post format" options={FORMATS} value={format} onChange={setFormat} />
      <div className="form-grid">
        <label className="field"><span>Keep posts live for (hours)</span><input name="min_live_hours" inputMode="numeric" defaultValue="72" /></label>
        <label className="field"><span>Sponsorship disclosure</span><input name="disclosure_text" defaultValue="#ad" /></label>
      </div>

      {performanceEnabled && <fieldset className="choice-group">
        <legend>How you pay</legend>
        <div className="choice-cards choice-cards-two">
          <label className="choice-card cat-publish">
            <input type="radio" name="payment_model" value="FIXED" checked={paymentModel === 'FIXED'} onChange={() => setPaymentModel('FIXED')} />
            <strong>Fixed fee</strong>
            <small>One agreed price per post, whatever it reaches.</small>
          </label>
          <label className="choice-card cat-create">
            <input type="radio" name="payment_model" value="PERFORMANCE" checked={paymentModel === 'PERFORMANCE'} onChange={() => setPaymentModel('PERFORMANCE')} />
            <strong>Fixed fee plus view bonus</strong>
            <small>A smaller fee, then a bonus for measured views up to a cap you set.</small>
          </label>
        </div>
      </fieldset>}

      {performance && <div className="performance-terms">
        <div className="form-grid">
          <label className="field"><span>Fixed fee per post (USD)</span><input name="base_fee" inputMode="decimal" value={baseFee} onChange={(event) => setBaseFee(event.target.value)} required /></label>
          <label className="field"><span>Bonus per 1,000 views (USD)</span><input name="rpm_rate" inputMode="decimal" value={rpmRate} onChange={(event) => setRpmRate(event.target.value)} required /></label>
          <label className="field"><span>Most bonus per creator (USD)</span><input name="bonus_cap" inputMode="decimal" value={bonusCap} onChange={(event) => setBonusCap(event.target.value)} required /></label>
        </div>
        <div className="form-grid">
          <label className="field"><span>Count views after (days)</span><input name="measure_after_days" inputMode="numeric" defaultValue="7" /></label>
          <label className="field"><span>Checking period before paying (days)</span><input name="verify_days" inputMode="numeric" defaultValue="7" /></label>
          <label className="field"><span>Views cap as a multiple of the creator's median</span><input name="median_multiplier" inputMode="decimal" defaultValue="3" /></label>
        </div>
        <p className="notice">You pay at most <strong>${maxPerHire.toFixed(2)} per creator</strong>: the fixed fee plus the whole bonus cap. That amount is held when you hire, and whatever the bonus does not use is returned to you. Views are counted once, at the checkpoint, and a count that does not look earned is held for review.</p>
      </div>}
    </div>}
  </>;
}
