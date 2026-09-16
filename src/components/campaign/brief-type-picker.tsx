'use client';

import { useState } from 'react';
import { CATEGORIES } from '../category';
import { GoalIcon } from './goal-icon';
import { CAMPAIGN_GOALS, goalByValue, type CampaignGoal } from '@/modules/requests/goals';

const PLATFORMS: [string, string][] = [['X', 'X'], ['INSTAGRAM', 'Instagram'], ['TIKTOK', 'TikTok'], ['YOUTUBE', 'YouTube'], ['NEWSLETTER', 'Newsletter'], ['WEBSITE', 'Website']];
const FORMATS: [string, string][] = [['POST', 'Post'], ['THREAD', 'Thread'], ['QUOTE_POST', 'Quote post'], ['VIDEO', 'Video'], ['NEWSLETTER_ISSUE', 'Newsletter issue'], ['ARTICLE', 'Article']];
const SESSION_MINUTES: [string, string][] = [['30', '30 minutes'], ['45', '45 minutes'], ['60', '1 hour'], ['90', '1.5 hours'], ['120', '2 hours']];

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
export function BriefTypePicker({ performanceEnabled, initialGoal = null }: { performanceEnabled: boolean; initialGoal?: CampaignGoal | null }) {
  const [goal, setGoal] = useState<CampaignGoal | null>(initialGoal);
  const [taxonomy, setTaxonomy] = useState<string>(goalByValue(initialGoal)?.taxonomy ?? CATEGORIES[0]!.value);
  const [platform, setPlatform] = useState('X');
  const [format, setFormat] = useState('POST');
  const [paymentModel, setPaymentModel] = useState('FIXED');
  const [sessionMinutes, setSessionMinutes] = useState('60');
  const [license, setLicense] = useState('NON_EXCLUSIVE');
  const [baseFee, setBaseFee] = useState('20');
  const [rpmRate, setRpmRate] = useState('2');
  const [bonusCap, setBonusCap] = useState('80');

  const publish = taxonomy === 'PUBLISH';
  const access = taxonomy === 'ACCESS';
  const digital = taxonomy === 'DIGITAL';
  const performance = publish && performanceEnabled && paymentModel === 'PERFORMANCE';
  const maxPerHire = usd(baseFee) + usd(bonusCap);

  // A goal suggests the kind of work that usually fits it; the buyer can still pick another below.
  const chooseGoal = (next: CampaignGoal) => {
    setGoal(next);
    setTaxonomy(goalByValue(next)!.taxonomy);
  };

  return <>
    <fieldset className="choice-group">
      <legend>What is the campaign for?</legend>
      <div className="choice-cards goal-cards">
        {CAMPAIGN_GOALS.map((item) => <label key={item.value} className="choice-card goal-card">
          <input type="radio" name="campaign_goal" value={item.value} checked={goal === item.value} onChange={() => chooseGoal(item.value)} required />
          <span className="choice-icon"><GoalIcon goal={item.value} size={19} /></span>
          <strong>{item.title}</strong>
          <small>{item.short}</small>
        </label>)}
      </div>
    </fieldset>

    <fieldset className="choice-group">
      <legend>What do you need?</legend>
      <div className="choice-cards">
        {CATEGORIES.map((category) => <label key={category.value} className="choice-card">
          <input type="radio" name="taxonomy" value={category.value} checked={taxonomy === category.value} onChange={() => setTaxonomy(category.value)} required />
          <span className="choice-icon">{category.icon}</span>
          <strong>{category.title}</strong>
          <small>{category.need}</small>
        </label>)}
      </div>
    </fieldset>

    {access && <div className="publish-block">
      <h3 className="brief-section">The session you are booking</h3>
      <p className="muted">You hire the creator&apos;s time. The day, hour and meeting link are agreed with them in the order messages, so neither side is held to a slot before the other agrees.</p>
      <Chips name="access_session_minutes" legend="Session length" options={SESSION_MINUTES} value={sessionMinutes} onChange={setSessionMinutes} />
    </div>}

    {digital && <div className="publish-block">
      <h3 className="brief-section">The files and what you may do with them</h3>
      <p className="muted">A commission, not a listing: the creator makes the files for you and hands them over in the order. There is no stock or download limit here — only the rights you agree on, which are frozen when you hire.</p>
      <fieldset className="choice-group">
        <legend>License</legend>
        <div className="choice-cards choice-cards-two">
          <label className="choice-card">
            <input type="radio" name="license_kind" value="NON_EXCLUSIVE" checked={license === 'NON_EXCLUSIVE'} onChange={() => setLicense('NON_EXCLUSIVE')} />
            <strong>Non-exclusive</strong>
            <small>You may use the files as agreed; the creator keeps the right to license them to others.</small>
          </label>
          <label className="choice-card">
            <input type="radio" name="license_kind" value="EXCLUSIVE" checked={license === 'EXCLUSIVE'} onChange={() => setLicense('EXCLUSIVE')} />
            <strong>Exclusive to you</strong>
            <small>The creator does not license the same files to anyone else. Expect a higher quote.</small>
          </label>
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="license-rights-text">What you may do with the files</label>
        <textarea id="license-rights-text" name="license_rights_text" rows={3} minLength={20} maxLength={4000} required
          defaultValue="Use in our own marketing on any channel, edit for size and language, worldwide, with no time limit. Reselling the files as a product is not included." />
      </div>
    </div>}

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
          <label className="choice-card">
            <input type="radio" name="payment_model" value="FIXED" checked={paymentModel === 'FIXED'} onChange={() => setPaymentModel('FIXED')} />
            <strong>Fixed fee</strong>
            <small>One agreed price per post, whatever it reaches.</small>
          </label>
          <label className="choice-card">
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
